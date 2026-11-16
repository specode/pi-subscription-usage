import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Keep the extension offline and independent of a globally installed Pi.
const sdkUrl = "data:text/javascript," + encodeURIComponent(`
export const CONFIG_DIR_NAME = '.pi';
export const readStoredCredential = () => undefined;
export const getAgentDir = () => process.env.PI_TEST_AGENT_DIR ?? '/nonexistent/pi-reset-test';
`);
registerHooks({
	resolve(specifier, context, next) {
		return specifier === "@earendil-works/pi-coding-agent"
			? { url: sdkUrl, shortCircuit: true }
			: next(specifier, context);
	},
});

const CODEX_MODEL = {
	provider: "openai-codex",
	id: "gpt-5-codex",
	baseUrl: "https://chatgpt.com",
};

function codexToken(accountId: string): string {
	const claims = {
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	};
	return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

const ACCESS = codexToken("account-fixture");

async function startExtension(config?: object) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-reset-test-"));
	process.env.PI_TEST_AGENT_DIR = agentDir;
	if (config) {
		writeFileSync(
			join(agentDir, "subscription-usage.json"),
			JSON.stringify(config),
		);
	}
	const { default: extension } = await import("../src/usage.ts");
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	extension({
		on: (name: string, handler: Function) => {
			handlers.set(name, handler);
		},
		registerCommand: (name: string, command: { handler: Function }) => {
			commands.set(name, command);
		},
		events: { emit: () => {} },
	} as never);
	const models = [CODEX_MODEL];
	const notices: string[] = [];
	const prompts: string[] = [];
	const ctx = {
		model: CODEX_MODEL,
		hasUI: true,
		cwd: agentDir,
		isProjectTrusted: () => false,
		modelRegistry: {
			getAll: () => models,
			getAvailable: () => models,
			isUsingOAuth: () => true,
			getProviderAuth: async () => ({ auth: { apiKey: ACCESS } }),
		},
		ui: {
			setStatus: () => {},
			notify: (text: string) => {
				notices.push(text);
			},
			select: async (title: string) => {
				prompts.push(title);
				return undefined;
			},
		},
	};
	const settle = () => new Promise((resolve) => setImmediate(resolve));
	const emit = async (name: string, event: object = {}) => {
		await handlers.get(name)!(event, ctx);
		await settle();
	};
	const usage = async () => {
		await commands.get("usage")!.handler("", ctx);
		return notices.at(-1) ?? "";
	};
	return {
		notices,
		prompts,
		emit,
		usage,
		cleanup: async () => {
			await handlers.get("session_shutdown")?.({}, ctx);
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

function installFetch() {
	const original = globalThis.fetch;
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.endsWith("/wham/usage")) {
			return jsonResponse({
				rate_limit: {
					primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
				},
				rate_limit_reset_credits: { available_count: 1 },
			});
		}
		if (url.endsWith("/wham/rate-limit-reset-credits")) {
			return jsonResponse({
				available_count: 1,
				credits: [
					{
						id: "ticket",
						status: "available",
						reset_type: "codex_rate_limits",
						is_supported_by_plan: true,
					},
				],
			});
		}
		return jsonResponse({ error: "unexpected" }, 500);
	};
	return {
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

test("/usage offers a reset credit by default", async () => {
	const harness = await startExtension();
	const fetchStub = installFetch();
	try {
		await harness.emit("session_start");
		const text = await harness.usage();
		assert.match(text, /Resets Left +1/u);
		assert.deepEqual(harness.prompts, ["Reset Credits: 1 Available"]);
	} finally {
		fetchStub.restore();
		await harness.cleanup();
	}
});

test("offerResetCredits turns the reset prompt off", async () => {
	const harness = await startExtension({ offerResetCredits: false });
	const fetchStub = installFetch();
	try {
		await harness.emit("session_start");
		const text = await harness.usage();
		// The count still shows; only the prompt is gone.
		assert.match(text, /Resets Left +1/u);
		assert.deepEqual(harness.prompts, []);
	} finally {
		fetchStub.restore();
		await harness.cleanup();
	}
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
