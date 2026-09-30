import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOpenAIUsage, normalizeOpenAIPlanUsage, openaiClientIdFromAuthorization } from "../src/providers/openai.ts";
import { adapterForProvider, queryProviderUsage, resolveUsageAuth, UsageUnsupportedError } from "../src/query.ts";
import { formatUsageReport } from "../src/format.ts";
import { buildUsageStatusEvent, formatUsageStatusline } from "../src/status.ts";

const clientId = "oaiapp_fixture";
function token(client = clientId, extra = {}) {
	return `e30.${Buffer.from(JSON.stringify({
		iss: "https://auth.openai.com", aud: "https://api.openai.com/v1",
		scope: "openid chatgpt.tokens.use.direct", client_id: client, ...extra,
	})).toString("base64url")}.signature`;
}
const payload = {
	items: [{ id: clientId, name: "Pi", allowed_usage_percent: 100, windows: [
		{ used_percent: 1, remaining_percent: 99, limit_window_seconds: 604800, reset_at: 2_000_000_000 },
	] }],
};
const planPayload = {
	rate_limit: { primary_window: { used_percent: 18, limit_window_seconds: 604800, reset_at: 1_999_920_000 } },
	credits: { has_credits: true, unlimited: false, balance: "62500" },
	// Neither additional model limits nor the separate aggregate app window is Plan limits.
	chatpass: { windows: [{ used_percent: 3, limit_window_seconds: 604800 }] },
	additional_rate_limits: [{ metered_feature: "gpt-6.1-sol", rate_limit: { primary_window: { used_percent: 70, limit_window_seconds: 604800 } } }],
};
const adapter = adapterForProvider("openai")!;
const model = { provider: "openai", id: "gpt-6.1-sol", baseUrl: "https://api.openai.com/v1" };
const codex = { provider: "openai-codex", id: "gpt-codex", baseUrl: "https://chatgpt.com/backend-api" };

type Context = Parameters<typeof resolveUsageAuth>[0];
function context(options: {
	access?: string; backend?: string; companion?: boolean; oauth?: boolean;
	codexOAuth?: boolean; baseUrl?: string; backendOrigin?: string; authOrigin?: string;
} = {}): Context {
	return {
		model: { ...model, baseUrl: options.baseUrl ?? model.baseUrl },
		modelRegistry: {
			getAvailable: () => options.companion === false ? [model] : [model, codex],
			getAll: () => options.companion === false ? [model] : [model, codex],
			isUsingOAuth: (m: { provider: string }) => m.provider === "openai" ? options.oauth !== false : options.codexOAuth !== false,
			getProviderAuth: async (id: string) => ({ auth: {
				apiKey: id === "openai" ? options.access ?? token() : options.backend ?? "backend-secret",
				baseUrl: id === "openai" ? options.authOrigin ?? model.baseUrl : options.backendOrigin ?? codex.baseUrl,
				headers: {},
			} }),
		},
	} as unknown as Context;
}

test("OpenAI app windows reuse the existing bars, status event and countdown", () => {
	const report = normalizeOpenAIUsage(payload, clientId, 123);
	assert.equal(report.providerId, "openai");
	assert.equal(report.buckets[0].remaining, 99);
	assert.match(formatUsageReport(report), /█+░*\s+99% left/u);
	assert.match(formatUsageReport(report, "used"), /1% used/u);
	assert.equal(formatUsageStatusline(report, model, "remaining", 2_000_000_000_000 - 7_980_000), "1w 99% ↻2h13m");
	const status = buildUsageStatusEvent(report, model);
	assert.equal(status.status, "ready");
	if (status.status === "ready") assert.equal(status.windows[0].remainingPercent, 99);
	assert.equal(report.metrics.some(m => m.id === "reset-credits"), false);
});

test("only the exact active registration is selected, never a name or Codex quota", () => {
	const response = { rate_limit: { primary_window: { used_percent: 80 } }, items: [
		{ ...payload.items[0], id: "oaiapp_other", windows: [{ ...payload.items[0].windows[0], used_percent: 80, remaining_percent: 20 }] },
		...payload.items,
	] };
	assert.equal(normalizeOpenAIUsage(response, clientId, 1).buckets[0].used, 1);
	for (const invalid of [{ items: [] }, { items: [response.items[0]] }, { items: [...payload.items, ...payload.items] }, {}]) {
		assert.throws(() => normalizeOpenAIUsage(invalid, clientId, 1), /not uniquely found/u);
	}
});

test("missing or malformed app windows fail rather than inventing zero usage", () => {
	for (const windows of [[], [{}], [{ ...payload.items[0].windows[0], used_percent: -1 }], [{ ...payload.items[0].windows[0], limit_window_seconds: 0 }]]) {
		assert.throws(() => normalizeOpenAIUsage({ items: [{ ...payload.items[0], windows }] }, clientId, 1), /window/u);
	}
	const window = { used_percent: 20, limit_window_seconds: 18000 };
	const report = normalizeOpenAIUsage({ items: [{ ...payload.items[0], windows: [window] }] }, clientId, 1);
	assert.equal(report.buckets[0].remaining, 80);
	assert.equal(report.buckets[0].resetsAt, undefined);
});

test("API audience and direct-sharing scope are required for registration routing", () => {
	assert.equal(openaiClientIdFromAuthorization(`Bearer ${token()}`), clientId);
	for (const access of ["secret", token(clientId, { scope: "openid" }), token(clientId, { aud: "other" }), token(clientId, { iss: "other" }), token("bad\nvalue")]) {
		assert.throws(() => openaiClientIdFromAuthorization(`Bearer ${access}`), /Sign in with ChatGPT/u);
	}
});

test("OpenAI resolves two runtime credentials and sends only backend auth", async () => {
	const auth = await resolveUsageAuth(context(), adapter);
	assert.ok(auth);
	assert.equal(auth.actualProviderId, "openai");
	assert.equal(auth.model.provider, "openai");
	assert.equal(auth.openaiClientId, clientId);
	assert.deepEqual(auth.headers, { Authorization: "Bearer backend-secret" });
	assert.equal(auth.apiKey, undefined);
	const original = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer backend-secret");
		assert.equal(JSON.stringify(init).includes(token()), false);
		if (url === "https://chatgpt.com/backend-api/wham/usage") return new Response(JSON.stringify(planPayload));
		if (url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits") return new Response(JSON.stringify({ available_count: 0, credits: [] }));
		assert.equal(url, "https://chatgpt.com/backend-api/wham/usage/chatpass/apps");
		return new Response(JSON.stringify(payload));
	};
	try {
		const report = await queryProviderUsage(adapter, auth, new AbortController().signal, 1000);
		assert.equal(report.buckets[0].remaining, 82);
		assert.equal(report.buckets[1].remaining, 99);
		assert.equal(report.metrics.find(m => m.id === "reset-credits")?.value, 0);
	} finally { globalThis.fetch = original; }
});

test("OpenAI cache identity changes if either runtime credential changes", async () => {
	const salt = new Uint8Array(32).fill(1);
	const a = await resolveUsageAuth(context(), adapter, salt);
	const b = await resolveUsageAuth(context({ access: token("oaiapp_second") }), adapter, salt);
	const c = await resolveUsageAuth(context({ backend: "second-backend" }), adapter, salt);
	assert.notEqual(a?.fingerprint, b?.fingerprint);
	assert.notEqual(a?.fingerprint, c?.fingerprint);
});

test("OpenAI API keys and custom origins are unsupported, not auth failures", async () => {
	for (const options of [
		{ oauth: false },
		{ baseUrl: "https://proxy.example/v1" },
		{ authOrigin: "https://proxy.example/v1" },
	]) await assert.rejects(resolveUsageAuth(context(options), adapter), UsageUnsupportedError);
});

test("missing or invalid Codex companion remains an authentication failure", async () => {
	for (const options of [
		{ codexOAuth: false }, { companion: false }, { backendOrigin: "https://proxy.example" },
	]) await assert.rejects(resolveUsageAuth(context(options), adapter), (error: Error) => {
		assert.equal(error instanceof UsageUnsupportedError, false);
		return true;
	});
});

test("OpenAI plan and app windows stay separate; footer and event use website plan limits", () => {
	const appPayload = { items: [{ ...payload.items[0], windows: [{ ...payload.items[0].windows[0], used_percent: 3, remaining_percent: 97 }] }] };
	const report = normalizeOpenAIPlanUsage(appPayload, planPayload, clientId, 123);
	assert.equal(report.buckets.length, 2);
	assert.equal(report.buckets[0].remaining, 82);
	assert.equal(report.buckets[1].remaining, 97);
	assert.equal(report.buckets[0].resetsAt, 1_999_920_000);
	assert.equal(report.buckets[1].resetsAt, 2_000_000_000);
	assert.equal(report.metrics.find(m => m.id === "credits")?.value, 62500);
	assert.equal(report.metrics.find(m => m.id === "allowance")?.label, "App Allowance");
	const panel = formatUsageReport(report);
	assert.match(panel, /Plan limits:[\s\S]*82% left[\s\S]*Pi app limits:[\s\S]*97% left/u);
	assert.match(panel, /Credits Balance\s+62500/u);
	const event = buildUsageStatusEvent(report, { ...model, name: "Pi app limits", id: "chatgpt-app" });
	assert.equal(event.status, "ready");
	if (event.status === "ready") {
		assert.equal(event.windows.length, 1);
		assert.equal(event.windows[0].remainingPercent, 82);
	}
	assert.equal(formatUsageStatusline(report, model, "remaining", 1_999_920_000_000 - 518400000), "1w 82% ↻6d");
	assert.equal(formatUsageStatusline(report, model, "used", 1_999_920_000_000 - 518400000), "1w 18% ↻6d");
});

test("missing plan windows or app match never fall back to a different quota domain", () => {
	assert.throws(() => normalizeOpenAIPlanUsage(payload, { credits: planPayload.credits }, clientId, 1), /plan usage windows/);
	assert.throws(() => normalizeOpenAIPlanUsage({ items: [] }, planPayload, clientId, 1), /not uniquely found/);
});

test("OpenAI errors redact both tokens and the registration ID", async () => {
	const auth = await resolveUsageAuth(context(), adapter);
	assert.ok(auth);
	const original = globalThis.fetch;
	globalThis.fetch = async () => new Response(`${token()} backend-secret ${clientId}`, { status: 401 });
	try {
		await assert.rejects(queryProviderUsage(adapter, auth, new AbortController().signal, 1000), (e: Error) => {
			assert.ok(!e.message.includes(token()));
			assert.ok(!e.message.includes("backend-secret"));
			assert.ok(!e.message.includes(clientId));
			return true;
		});
	} finally { globalThis.fetch = original; }
});
