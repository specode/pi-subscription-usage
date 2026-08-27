import assert from "node:assert/strict";
import test from "node:test";
import { verifyCodexStoredOAuthCredential } from "../src/codex-reset-core.ts";
import { adapterForProvider, resolveUsageAuth } from "../src/query.ts";

type ResolveContext = Parameters<typeof resolveUsageAuth>[0];

function requiredAdapter(providerId: string) {
	const adapter = adapterForProvider(providerId);
	if (!adapter) throw new Error(`Missing test adapter: ${providerId}`);
	return adapter;
}

function origin(host: string, path = ""): string {
	return `https:${"//"}${host}${path}`;
}

function context(options: {
	provider: string;
	baseUrl: string;
	usingOAuth?: boolean;
	authBaseUrl?: string;
}): ResolveContext {
	const model = {
		provider: options.provider,
		id: "test-model",
		name: "Test Model",
		baseUrl: options.baseUrl,
	};
	return {
		model,
		modelRegistry: {
			getAvailable: () => [model],
			getAll: () => [model],
			isUsingOAuth: () => options.usingOAuth ?? false,
			getProviderAuth: async () => ({
				auth: {
					apiKey: "fixture-secret",
					headers: {},
					baseUrl: options.authBaseUrl ?? options.baseUrl,
				},
			}),
		},
	} as unknown as ResolveContext;
}

test("rejects a current provider with a custom credential origin", async () => {
	const adapter = requiredAdapter("kimi-coding");
	await assert.rejects(
		resolveUsageAuth(
			context({ provider: "kimi-coding", baseUrl: origin("proxy.example.com") }),
			adapter,
		),
		/custom provider credential/u,
	);
});

test("accepts official Kimi runtime auth and forwards only authorization", async () => {
	const adapter = requiredAdapter("kimi-coding");
	const auth = await resolveUsageAuth(
		context({
			provider: "kimi-coding",
			baseUrl: origin("api.kimi.com", "/coding"),
		}),
		adapter,
		new Uint8Array(32).fill(7),
	);
	assert.deepEqual(auth?.headers, { Authorization: "Bearer fixture-secret" });
	assert.equal(auth?.actualProviderId, "kimi-coding");
	assert.equal(auth?.fingerprint.length, 64);
});

test("rejects Grok API-key auth when OAuth is required", async () => {
	const adapter = requiredAdapter("xai");
	await assert.rejects(
		resolveUsageAuth(
			context({
				provider: "xai",
				baseUrl: origin("api.x.ai", "/v1"),
				usingOAuth: false,
			}),
			adapter,
		),
		/requires Pi OAuth/u,
	);
});

test("configured Grok lookup skips API-key models and selects Pi OAuth", async () => {
	const current = {
		provider: "kimi-coding",
		id: "k3",
		baseUrl: origin("api.kimi.com", "/coding"),
	};
	const apiKeyModel = {
		provider: "xai",
		id: "grok-api",
		baseUrl: origin("api.x.ai", "/v1"),
	};
	const oauthModel = {
		provider: "xai-auth",
		id: "grok-oauth",
		baseUrl: origin("api.x.ai", "/v1"),
	};
	const ctx = {
		model: current,
		modelRegistry: {
			getAvailable: () => [apiKeyModel, oauthModel],
			getAll: () => [apiKeyModel, oauthModel],
			isUsingOAuth: (model: { provider: string }) => model.provider === "xai-auth",
			getProviderAuth: async (providerId: string) => ({
				auth: {
					apiKey: "fixture-secret",
					headers: {},
					baseUrl: origin("api.x.ai", "/v1"),
				},
				providerId,
			}),
		},
	} as unknown as ResolveContext;
	const auth = await resolveUsageAuth(
		ctx,
		requiredAdapter("xai"),
		new Uint8Array(32).fill(9),
	);
	assert.equal(auth?.actualProviderId, "xai-auth");
});

function codexAccessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
		"base64url",
	);
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url");
	return `${header}.${payload}.fixture-signature`;
}

test("Codex reset auth requires the stored OAuth account to match runtime", () => {
	const accountId = "account-fixture";
	const access = codexAccessToken(accountId);
	assert.equal(
		verifyCodexStoredOAuthCredential(access, {
			type: "oauth",
			access,
			refresh: "fixture-refresh",
			expires: Date.now() + 60_000,
			accountId,
		}),
		accountId,
	);
	assert.throws(
		() =>
			verifyCodexStoredOAuthCredential(access, {
				type: "oauth",
				access,
				refresh: "fixture-refresh",
				expires: Date.now() + 60_000,
				accountId: "different-account",
			}),
		/does not match Pi's stored OAuth account/u,
	);
});
