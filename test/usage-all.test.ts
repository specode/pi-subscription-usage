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
export const getAgentDir = () => process.env.PI_TEST_AGENT_DIR ?? '/nonexistent/pi-usage-all-test';
`);
registerHooks({
	resolve(specifier, context, next) {
		return specifier === "@earendil-works/pi-coding-agent"
			? { url: sdkUrl, shortCircuit: true }
			: next(specifier, context);
	},
});

const ACTIVE_MODEL = {
	provider: "kimi-coding",
	id: "kimi-for-coding",
	baseUrl: "https://api.kimi.com",
};
const SECOND_MODEL = {
	provider: "opencode-go",
	id: "grok-code",
	baseUrl: "https://opencode.ai",
};
const CLAUDE_MODEL = { provider: "claude-bridge", id: "claude-haiku-4-5" };

const ACTIVE_USAGE = {
	usage: { limit: 100, used: 25, resetTime: "2026-12-01T00:00:00Z" },
};
const SECOND_USAGE = {
	usage: {
		rolling: { status: "ok", percent: 12, resetsAt: "2026-12-01T00:00:00Z" },
		weekly: { status: "rate-limited", percent: 100 },
	},
};

async function startExtension(options: {
	showAllProviders?: boolean;
	models?: object[];
}) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-all-"));
	process.env.PI_TEST_AGENT_DIR = agentDir;
	if (options.showAllProviders !== undefined) {
		writeFileSync(
			join(agentDir, "subscription-usage.json"),
			JSON.stringify({ showAllProviders: options.showAllProviders }),
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
	const models = options.models ?? [ACTIVE_MODEL];
	const statuses: (string | undefined)[] = [];
	const notices: string[] = [];
	const ctx = {
		model: ACTIVE_MODEL,
		hasUI: true,
		cwd: agentDir,
		isProjectTrusted: () => false,
		modelRegistry: {
			getAll: () => models,
			getAvailable: () => models,
			isUsingOAuth: () => false,
			getProviderAuth: async (provider: string) => ({
				auth: { apiKey: `key-${provider}` },
			}),
		},
		ui: {
			setStatus: (_key: string, value: string | undefined) => {
				statuses.push(value);
			},
			notify: (text: string) => {
				notices.push(text);
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
		ctx,
		statuses,
		notices,
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
	const calls: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		calls.push(url);
		if (url.includes("api.kimi.com")) return jsonResponse(ACTIVE_USAGE);
		if (url.includes("opencode.ai")) return jsonResponse(SECOND_USAGE);
		return jsonResponse({ error: "unexpected" }, 500);
	};
	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

test("/usage lists only the active provider by default", async () => {
	const harness = await startExtension({
		models: [ACTIVE_MODEL, SECOND_MODEL],
	});
	const fetchStub = installFetch();
	try {
		await harness.emit("session_start");
		const text = await harness.usage();
		assert.match(text, /^Kimi Coding\n/u);
		assert.doesNotMatch(text, /OpenCode Go/u);
	} finally {
		fetchStub.restore();
		await harness.cleanup();
	}
});

test("/usage lists every signed-in provider when showAllProviders is on", async () => {
	const harness = await startExtension({
		showAllProviders: true,
		models: [ACTIVE_MODEL, SECOND_MODEL, CLAUDE_MODEL],
	});
	const fetchStub = installFetch();
	try {
		await harness.emit("session_start");
		const text = await harness.usage();
		const blocks = text.split("\n\n");
		assert.match(blocks[0] ?? "", /^Kimi Coding\n/u);
		assert.match(text, /OpenCode Go\n  5h Window/u);
		assert.match(text, /Claude \(Claude Code\)\n  Waiting: /u);
		// The footer keeps the active provider only.
		assert.match(harness.statuses.at(-1) ?? "", /^1w 75% /u);
	} finally {
		fetchStub.restore();
		await harness.cleanup();
	}
});

test("/usage reuses the cache for providers other than the active one", async () => {
	const harness = await startExtension({
		showAllProviders: true,
		models: [ACTIVE_MODEL, SECOND_MODEL],
	});
	const fetchStub = installFetch();
	try {
		await harness.emit("session_start");
		const calls = (host: string) =>
			fetchStub.calls.filter((url) => url.includes(host)).length;
		await harness.usage();
		assert.equal(calls("opencode.ai"), 1);
		const activeCalls = calls("api.kimi.com");
		await harness.usage();
		assert.equal(calls("opencode.ai"), 1);
		// The active provider is always fresh.
		assert.equal(calls("api.kimi.com") - activeCalls, 1);
	} finally {
		fetchStub.restore();
		await harness.cleanup();
	}
});

test("skips providers Pi holds no credential for", async () => {
	const harness = await startExtension({
		showAllProviders: true,
		models: [ACTIVE_MODEL],
	});
	const fetchStub = installFetch();
	try {
		await harness.emit("session_start");
		const text = await harness.usage();
		assert.doesNotMatch(text, /OpenCode Go|Grok|Antigravity|Claude/u);
		assert.doesNotMatch(text, /No Pi runtime credential/u);
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
