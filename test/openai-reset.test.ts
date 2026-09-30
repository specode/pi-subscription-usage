import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { CODEX_RESET_CONFIRMATION_OPTIONS, normalizeCodexResetCreditsPayload } from "../src/codex-reset-core.ts";

// Keep tests offline and independent of a globally installed Pi or real auth.json.
const sdkUrl = "data:text/javascript," + encodeURIComponent(`
export const CONFIG_DIR_NAME = '.pi';
export const credentials = new Map();
export const readStoredCredential = id => credentials.get(id);
export const getAgentDir = () => '/nonexistent/pi-reset-test';
`);
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@earendil-works/pi-coding-agent"
		? { url: sdkUrl, shortCircuit: true } : next(specifier, context);
} });
const { credentials } = await import(sdkUrl);
const { resolveCodexResetAuth, consumeCodexResetCredit } = await import("../src/codex-resets.ts");
const { default: extension } = await import("../src/usage.ts");
const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const appToken = (id = "oaiapp_test") => jwt({ iss: "https://auth.openai.com", aud: "https://api.openai.com/v1", scope: "chatgpt.tokens.use.direct", client_id: id });
const backendToken = (id = "account-test") => jwt({ "https://api.openai.com/auth": { chatgpt_account_id: id } });
const openai = { provider: "openai", id: "model", baseUrl: "https://api.openai.com/v1" };
const codex = { provider: "openai-codex", id: "codex", baseUrl: "https://chatgpt.com/backend-api" };
const credit = { id: "credit-test", reset_type: "codex_rate_limits", status: "available", is_supported_by_plan: true };
const apps = { items: [{ id: "oaiapp_test", windows: [{ used_percent: 10, remaining_percent: 90, limit_window_seconds: 604800 }] }] };
function fixture() {
	credentials.clear();
	credentials.set("openai", { type: "oauth", access: appToken(), refresh: "refresh-app" });
	credentials.set("openai-codex", { type: "oauth", access: backendToken(), refresh: "refresh-backend", accountId: "account-test" });
	let access = appToken(), backend = backendToken();
	const ctx = {
		model: openai, hasUI: true, cwd: "/nonexistent/pi-reset-test", isProjectTrusted: () => false,
		modelRegistry: {
			getAll: () => [openai, codex], getAvailable: () => [openai, codex], isUsingOAuth: () => true,
			getProviderAuth: async (id: string) => ({ auth: { apiKey: id === "openai" ? access : backend, headers: {}, baseUrl: id === "openai" ? openai.baseUrl : codex.baseUrl } }),
		},
		ui: { setStatus: () => {}, notify: (_text: string) => {}, select: async (_title: string, _options: string[]): Promise<string | undefined> => undefined },
	};
	return { ctx, changeApp() { access = appToken("oaiapp_changed"); }, changeBackend() { backend = backendToken("account-other"); } };
}

test("OpenAI reset auth binds both stored OAuth credentials and account header", async () => {
	const f = fixture();
	const auth = await resolveCodexResetAuth(f.ctx as never);
	assert.equal(auth.actualProviderId, "openai");
	assert.equal(auth.openaiClientId, "oaiapp_test");
	assert.equal(auth.headers.Authorization, `Bearer ${backendToken()}`);
	assert.equal(auth.headers["chatgpt-account-id"], "account-test");
	assert.ok(auth.usageFingerprint);
	f.changeApp();
	await assert.rejects(resolveCodexResetAuth(f.ctx as never), /OpenAI runtime account/);
	const g = fixture(); g.changeBackend();
	await assert.rejects(resolveCodexResetAuth(g.ctx as never), /Codex runtime account/);
});

test("OpenAI reset list requires supported explicit tickets and excludes expired ones", () => {
	const result = normalizeCodexResetCreditsPayload({ available_count: 6, credits: [
		credit, { ...credit, id: "unsupported", is_supported_by_plan: false },
		{ ...credit, id: "expired", expires_at: "2020-01-01T00:00:00Z" },
		{ ...credit, id: "unknown", reset_type: "unknown" },
		{ ...credit, id: "redeemed", status: "redeemed" },
	] }, { now: Date.parse("2026-01-01") });
	assert.equal(result.availableCount, 1);
	assert.equal(result.options[0].creditId, "credit-test");
	assert.equal(normalizeCodexResetCreditsPayload({ available_count: 2 }).availableCount, 0);
});

test("consume refuses an automatic unscoped credit selection in both modes", async () => {
	const original = globalThis.fetch;
	let requests = 0;
	// Count instead of relying on an outer guard: a regression must never reach the network.
	globalThis.fetch = async () => { requests += 1; return new Response("{}"); };
	try {
		for (const model of [openai, codex]) {
			const f = fixture(); f.ctx.model = model;
			const auth = await resolveCodexResetAuth(f.ctx as never);
			await assert.rejects(consumeCodexResetCredit(auth, { title: "Reset", description: "" }, "request", new AbortController().signal, 100), /explicitly selected/);
		}
		assert.equal(requests, 0);
	} finally { globalThis.fetch = original; }
});

const scenarios = [
	"cancel", "confirm", "retry", "change-app", "change-backend", "switch-model",
	"missing-app", "list-failed", "display-list-failed", "retry-change-app", "retry-change-backend",
	"retry-get-failed", "retry-cancel", "refresh-failed", "publish-failed",
	"status-failed", "already-redeemed",
] as const;

for (const provider of ["openai", "openai-codex"] as const) {
for (const scenario of scenarios) {
	const isOpenAI = provider === "openai";
	if (!isOpenAI && ["change-app", "missing-app", "retry-change-app", "retry-get-failed"].includes(scenario)) continue;
	test(`${provider} reset UI: ${scenario}`, { timeout: 5000 }, async () => {
		const f = fixture();
		if (!isOpenAI) f.ctx.model = codex;
		const handlers = new Map<string, Function>(), commands = new Map<string, { handler: Function }>();
		const notices: string[] = [], posts: Record<string, string>[] = [];
		const menus: { title: string; options: string[] }[] = [];
		const violations: unknown[] = [];
		// Application catches must not swallow test assertion failures.
		const check = (assertion: () => void) => { try { assertion(); } catch (error) { violations.push(error); } };
		let confirmationSeen = false, redeemChosen = false, phase: "startup" | "command" = "startup";
		let startupDone!: () => void;
		const startup = new Promise<void>(resolve => { startupDone = resolve; });
		f.ctx.ui.notify = text => { notices.push(text); };
		f.ctx.ui.setStatus = () => {
			if (scenario === "status-failed" && posts.length) throw new Error("status display failed");
		};
		f.ctx.ui.select = async (title, options) => {
			menus.push({ title, options: [...options] });
			if (title.startsWith("Redeem one")) {
				check(() => {
					if (isOpenAI) { assert.match(title, /companion Codex account/); assert.match(title, /not guaranteed/); }
					assert.equal(options[0], "Cancel (Default)");
				});
				confirmationSeen = true;
				if (scenario === "change-app") f.changeApp();
				if (scenario === "change-backend") f.changeBackend();
				if (scenario === "switch-model") f.ctx.model = isOpenAI ? codex : openai;
				return scenario === "cancel" ? options[0] : CODEX_RESET_CONFIRMATION_OPTIONS[1];
			}
			if (title === "Reset Result Uncertain") {
				if (scenario === "retry-change-app") f.changeApp();
				if (scenario === "retry-change-backend") f.changeBackend();
				// Bound retries so a broken success path fails rather than hanging.
				return scenario === "retry-cancel" || menus.filter(m => m.title === title).length > 1 ? "Cancel" : options[0];
			}
			check(() => assert.ok(title.startsWith("Reset Credits:") || title.startsWith("Choose ")));
			if (title.startsWith("Reset Credits:")) redeemChosen = true;
			return options[0];
		};
		const original = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			const headers = init?.headers as Record<string, string>;
			check(() => assert.equal(headers.Authorization, `Bearer ${backendToken()}`));
			if (init?.method === "POST") {
				// Count every attempted mutation, even one with invalid URL/headers/body.
				const body = JSON.parse(init.body as string);
				posts.push(body);
				check(() => {
					assert.ok(confirmationSeen);
					assert.equal(url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
					assert.equal(headers["chatgpt-account-id"], "account-test");
					assert.equal(body.credit_id, "credit-test");
					assert.deepEqual(Object.keys(body).sort(), ["credit_id", "redeem_request_id"]);
				});
				if (scenario.startsWith("retry") && posts.length === 1) throw new Error("transport uncertain");
				return new Response(JSON.stringify({ code: scenario === "already-redeemed" ? "already_redeemed" : "reset", windows_reset: 1 }));
			}
			if (String(url).endsWith("/wham/usage")) {
				if (posts.length && (scenario === "retry-get-failed" || scenario === "refresh-failed")) throw new Error("plan query failed");
				return new Response(JSON.stringify({
					rate_limit: { primary_window: { used_percent: 18, limit_window_seconds: 604800 } },
					rate_limit_reset_credits: { available_count: posts.length ? 0 : 1 },
				}));
			}
			if (String(url).endsWith("/chatpass/apps")) {
				return new Response(JSON.stringify(scenario === "missing-app" && confirmationSeen ? { items: [] } : apps));
			}
			check(() => assert.ok(String(url).endsWith("/rate-limit-reset-credits")));
			// Display and redemption listings are scoped to the same backend account.
			check(() => assert.equal(headers["chatgpt-account-id"], "account-test"));
			// Fail only /usage's display read, or only redemption's own listing.
			const failList = scenario === "list-failed" ? redeemChosen : scenario === "display-list-failed" && !redeemChosen;
			if (failList && phase === "command" && !confirmationSeen) throw new Error("list unavailable");
			return new Response(JSON.stringify({ available_count: posts.length ? 0 : 1, credits: posts.length ? [] : [credit] }));
		};
		try {
			extension({
				on: (name: string, handler: Function) => handlers.set(name, handler),
				registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command),
				events: { emit(_name: string, event: { status: string }) {
					if (phase === "startup") { check(() => assert.equal(event.status, "ready")); startupDone(); }
					if (scenario === "publish-failed" && posts.length) throw new Error("subscriber failed");
				} },
			} as never);
			handlers.get("session_start")!({}, f.ctx);
			await startup; // Wait for published startup result, not an arbitrary event-loop turn.
			phase = "command";
			await commands.get("usage")!.handler("", f.ctx);
			assert.deepEqual(violations, []);
			const offered = scenario !== "display-list-failed";
			const listed = offered && scenario !== "list-failed";
			assert.equal(menus.some(m => m.title.startsWith("Reset Credits:")), offered);
			assert.equal(confirmationSeen, listed);
			assert.equal(menus.some(m => m.title.startsWith("Choose ")), listed);
			const zeroPosts = ["cancel", "change-app", "change-backend", "switch-model", "missing-app", "list-failed", "display-list-failed"].includes(scenario);
			assert.equal(posts.length, zeroPosts ? 0 : scenario === "retry" ? 2 : 1);
			const messages = notices.join("\n");
			const uncertain = scenario.startsWith("retry-");
			if (uncertain) {
				assert.match(messages, /Reset result uncertain;.*check/);
				assert.doesNotMatch(messages, /not redeemed|not submitted|Reset redeemed/);
			} else if (!zeroPosts) {
				assert.match(messages, /Reset (already )?redeemed/);
				assert.equal(menus.filter(m => m.title === "Reset Result Uncertain").length, scenario === "retry" ? 1 : 0);
			}
			if (["refresh-failed", "publish-failed", "status-failed"].includes(scenario)) {
				assert.match(messages, /Reset result confirmed, but usage refresh/);
				assert.doesNotMatch(messages, /Reset result uncertain/);
			}
			if (scenario === "change-app") assert.match(messages, /OpenAI runtime account does not match/);
			if (scenario === "change-backend") assert.match(messages, /Codex runtime account does not match/);
			if (scenario === "switch-model") assert.match(messages, /changed; reset not submitted/);
			if (scenario === "missing-app") assert.match(messages, /not uniquely found/);
			if (scenario === "list-failed") assert.match(messages, /list unavailable/);
			if (scenario === "display-list-failed") assert.match(messages, /availability could not be verified/);
			if (scenario === "cancel") assert.doesNotMatch(messages, /failed|uncertain|redeemed/);
			if (scenario === "retry") assert.equal(posts[0].redeem_request_id, posts[1].redeem_request_id);
		} finally {
			f.ctx.ui.setStatus = () => {};
			// Avoid test-injected publish failure during shutdown cleanup.
			posts.length = 0;
			handlers.get("session_shutdown")?.({}, f.ctx);
			globalThis.fetch = original;
		}
	});
}
}
