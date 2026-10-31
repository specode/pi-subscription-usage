import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageReport } from "../src/format.ts";
import {
	ANTIGRAVITY_3P_GROUP_ID,
	ANTIGRAVITY_ARGON_GROUP_ID,
	ANTIGRAVITY_DEFAULT_GROUP_ID,
	ANTIGRAVITY_PROVIDER_ID,
	ANTIGRAVITY_USER_AGENT,
	emailFromAntigravityCredential,
	extractAntigravityAuth,
	normalizeAntigravityUsage,
} from "../src/providers/antigravity.ts";
import { adapterForProvider, resolveUsageAuth, UsageUnsupportedError } from "../src/query.ts";
import { formatUsageStatusline } from "../src/status.ts";

const FIXTURE_QUOTA_SUMMARY = {
	groups: [
		{
			displayName: "Gemini Models",
			description: "Models within this group: Gemini Flash, Gemini Pro",
			buckets: [
				{
					bucketId: "gemini-weekly",
					displayName: "Weekly Limit Remaining",
					window: "weekly",
					resetTime: "2026-11-07T05:09:06Z",
					remainingFraction: 0.9640643,
				},
				{
					bucketId: "gemini-5h",
					displayName: "Five Hour Limit Remaining",
					window: "5h",
					resetTime: "2026-10-31T10:09:06Z",
					remainingFraction: 0.89407855,
				},
			],
		},
		{
			displayName: "Claude and GPT models",
			description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
			buckets: [
				{
					bucketId: "3p-weekly",
					displayName: "Weekly Limit Remaining",
					window: "weekly",
					resetTime: "2026-11-07T05:02:27Z",
					remainingFraction: 0.492402,
				},
				{
					bucketId: "3p-5h",
					displayName: "Five Hour Limit Remaining",
					window: "5h",
					resetTime: "2026-10-31T10:02:27Z",
					remainingFraction: 0,
				},
			],
		},
		{
			displayName: "Gemini 4 Argon",
			description: "For paid Pro plans, Argon quota is separate.",
			buckets: [
				{
					bucketId: "gemini-argon-wtu-weekly",
					displayName: "Gemini 4 Argon Weekly Limit",
					window: "weekly",
					resetTime: "2026-11-07T05:01:27Z",
					remainingFraction: 0.40190613,
				},
			],
		},
	],
	description: "Within each group, models share a weekly limit and a 5-hour limit.",
};

function antigravityAuth() {
	return {
		actualProviderId: ANTIGRAVITY_PROVIDER_ID,
		headers: { Authorization: "Bearer ya29.test" },
		fingerprint: "test-fp",
		secrets: ["ya29.test"],
		accountEmail: "tester@example.com",
		model: {
			provider: ANTIGRAVITY_PROVIDER_ID,
			id: "gemini-3.8-flash",
			baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		},
	};
}

const FIXTURE_PLAN_PAYLOAD = {
	currentTier: { id: "free-tier", name: "Antigravity" },
	paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
	cloudaicompanionProject: "aicode-consumers",
};

test("normalizes Antigravity 3 quota groups (Gemini, Claude & GPT, Argon)", () => {
	const capturedAt = 1_793_440_000_000;
	const report = normalizeAntigravityUsage(
		FIXTURE_QUOTA_SUMMARY,
		capturedAt,
		FIXTURE_PLAN_PAYLOAD,
		"youlu.cn@gmail.com",
	);

	assert.equal(report.providerId, ANTIGRAVITY_PROVIDER_ID);
	assert.equal(report.providerName, "Antigravity");
	assert.equal(report.defaultGroupId, ANTIGRAVITY_DEFAULT_GROUP_ID);
	assert.equal(report.buckets.length, 5);

	const gemini5h = report.buckets.find((b) => b.id === `${ANTIGRAVITY_DEFAULT_GROUP_ID}:gemini-5h`);
	assert.ok(gemini5h);
	assert.equal(gemini5h.groupId, ANTIGRAVITY_DEFAULT_GROUP_ID);
	assert.equal(gemini5h.windowMinutes, 300);
	assert.equal(gemini5h.unit, "percent");
	assert.equal(gemini5h.limit, 100);
	assert.equal(gemini5h.remaining, 89.407855);
	assert.equal(gemini5h.used, 10.592145);
	assert.equal(gemini5h.resetsAt, 1793441346);

	const claude5h = report.buckets.find((b) => b.id === `${ANTIGRAVITY_3P_GROUP_ID}:3p-5h`);
	assert.ok(claude5h);
	assert.equal(claude5h.groupId, ANTIGRAVITY_3P_GROUP_ID);
	assert.equal(claude5h.remaining, 0);
	assert.equal(claude5h.used, 100);

	const argonWeekly = report.buckets.find((b) => b.id === `${ANTIGRAVITY_ARGON_GROUP_ID}:gemini-argon-wtu-weekly`);
	assert.ok(argonWeekly);
	assert.equal(argonWeekly.groupId, ANTIGRAVITY_ARGON_GROUP_ID);
	assert.equal(argonWeekly.windowMinutes, 10_080);
	assert.equal(argonWeekly.remaining, 40.190613);

	assert.deepEqual(report.metrics, [
		{ id: "email", label: "Email", value: "youlu.cn@gmail.com" },
		{ id: "plan", label: "Plan", value: "Google AI Pro" },
		{ id: "project", label: "Project", value: "aicode-consumers" },
	]);
});

test("selects correct usage group based on the model in footer statusline", () => {
	const fixedNow = Date.parse("2026-10-31T07:15:00Z");
	const report = normalizeAntigravityUsage(
		FIXTURE_QUOTA_SUMMARY,
		fixedNow,
		FIXTURE_PLAN_PAYLOAD,
	);

	// 1. Gemini models -> Gemini Models group (5h 89% · 1w 96%)
	assert.equal(
		formatUsageStatusline(report, {
			provider: ANTIGRAVITY_PROVIDER_ID,
			id: "gemini-3.8-flash",
			name: "Gemini 3.8 Flash (Antigravity)",
		}, "remaining", fixedNow),
		"5h 89% ↻2h54m · 1w 96% ↻6d21h",
	);

	assert.equal(
		formatUsageStatusline(report, {
			provider: ANTIGRAVITY_PROVIDER_ID,
			id: "gemini-3.1-pro",
			name: "Gemini 3.1 Pro (Antigravity)",
		}, "remaining", fixedNow),
		"5h 89% ↻2h54m · 1w 96% ↻6d21h",
	);

	assert.equal(
		formatUsageStatusline(report, {
			provider: ANTIGRAVITY_PROVIDER_ID,
			id: "gemini-3.7-flash",
		}, "remaining", fixedNow),
		"5h 89% ↻2h54m · 1w 96% ↻6d21h",
	);

	// 2. Claude and GPT models -> Claude and GPT group (5h 0% · 1w 49%)
	assert.equal(
		formatUsageStatusline(report, {
			provider: ANTIGRAVITY_PROVIDER_ID,
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6 (Antigravity)",
		}, "remaining", fixedNow),
		"5h 0% ↻2h47m · 1w 49% ↻6d21h",
	);

	assert.equal(
		formatUsageStatusline(report, {
			provider: ANTIGRAVITY_PROVIDER_ID,
			id: "claude-opus-4-6",
			name: "Claude Opus 4.6 (Antigravity)",
		}, "remaining", fixedNow),
		"5h 0% ↻2h47m · 1w 49% ↻6d21h",
	);

	assert.equal(
		formatUsageStatusline(report, {
			provider: ANTIGRAVITY_PROVIDER_ID,
			id: "gpt-oss-120b",
			name: "GPT-OSS 120B (Antigravity)",
		}, "remaining", fixedNow),
		"5h 0% ↻2h47m · 1w 49% ↻6d21h",
	);

	// 3. Argon models -> Gemini 4 Argon group (1w 40%)
	assert.equal(
		formatUsageStatusline(report, {
			provider: ANTIGRAVITY_PROVIDER_ID,
			id: "gemini-4-argon",
			name: "Gemini 4 Argon (Antigravity)",
		}, "remaining", fixedNow),
		"1w 40% ↻6d21h",
	);

	// 4. Undefined / unknown model falls back to default Gemini group
	assert.equal(
		formatUsageStatusline(report, undefined, "remaining", fixedNow),
		"5h 89% ↻2h54m · 1w 96% ↻6d21h",
	);

	assert.equal(
		formatUsageStatusline(report, {
			provider: ANTIGRAVITY_PROVIDER_ID,
			id: "unknown-model",
		}, "remaining", fixedNow),
		"5h 89% ↻2h54m · 1w 96% ↻6d21h",
	);
});

test("formats full usage report with 3 groups and account metadata", () => {
	const report = normalizeAntigravityUsage(
		FIXTURE_QUOTA_SUMMARY,
		Date.now(),
		FIXTURE_PLAN_PAYLOAD,
		"user@example.com",
	);
	const panel = formatUsageReport(report, "remaining");

	assert.match(panel, /^Antigravity/u);
	assert.match(panel, /Gemini Models:\n +5h Window +█+░+ +89% left/u);
	assert.match(panel, /1w Window +█+ +96% left/u);
	assert.match(panel, /Claude and GPT models:\n +5h Window +░+ +0% left/u);
	assert.match(panel, /1w Window +█+░+ +49% left/u);
	assert.match(panel, /Gemini 4 Argon:\n +1w Window +█+░+ +40% left/u);
	assert.match(panel, /Account:\n +Email +user@example\.com\n +Plan +Google AI Pro\n +Project +aicode-consumers/u);
});

test("extracts Antigravity auth from JSON apiKey and Bearer header", () => {
	// JSON with token and projectId (standard Pi format for pi-antigravity)
	const jsonAuth = extractAntigravityAuth(
		JSON.stringify({ token: "ya29.secret-token", projectId: "test-proj" }),
		undefined,
	);
	assert.equal(jsonAuth.token, "ya29.secret-token");
	assert.equal(jsonAuth.authorization, "Bearer ya29.secret-token");

	// JSON with access and email
	const jsonWithEmail = extractAntigravityAuth(
		JSON.stringify({ access: "ya29.access-token", email: "test@example.com" }),
		undefined,
	);
	assert.equal(jsonWithEmail.token, "ya29.access-token");
	assert.equal(jsonWithEmail.email, "test@example.com");
	assert.equal(jsonWithEmail.authorization, "Bearer ya29.access-token");

	// Raw plain token string
	const plainAuth = extractAntigravityAuth("raw-api-token", undefined);
	assert.equal(plainAuth.token, "raw-api-token");
	assert.equal(plainAuth.authorization, "Bearer raw-api-token");

	// From Bearer header containing JSON
	const bearerJson = extractAntigravityAuth(
		undefined,
		`Bearer ${JSON.stringify({ token: "ya29.header-token" })}`,
	);
	assert.equal(bearerJson.token, "ya29.header-token");
	assert.equal(bearerJson.authorization, "Bearer ya29.header-token");

	// From plain Bearer header
	const bearerPlain = extractAntigravityAuth(undefined, "Bearer ya29.plain");
	assert.equal(bearerPlain.token, "ya29.plain");
	assert.equal(bearerPlain.authorization, "Bearer ya29.plain");

	const missingToken = extractAntigravityAuth(
		JSON.stringify({ projectId: "test-proj" }),
		undefined,
	);
	assert.equal(missingToken.token, undefined);
	assert.equal(missingToken.authorization, undefined);
});

test("reads an Antigravity email only from the stored OAuth credential", () => {
	assert.equal(
		emailFromAntigravityCredential({
			type: "oauth",
			email: "User@Example.com",
		}),
		"user@example.com",
	);
	assert.equal(
		emailFromAntigravityCredential({ type: "api_key", email: "user@example.com" }),
		undefined,
	);
});

test("Antigravity adapter query sends official Antigravity User-Agent and calls endpoints", async () => {
	const adapter = adapterForProvider(ANTIGRAVITY_PROVIDER_ID);
	assert.ok(adapter);

	const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		calls.push({
			url: String(input),
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body ? String(init.body) : undefined,
		});
		if (String(input).includes("retrieveUserQuotaSummary")) {
			return new Response(JSON.stringify(FIXTURE_QUOTA_SUMMARY), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (String(input).includes("loadCodeAssist")) {
			return new Response(JSON.stringify(FIXTURE_PLAN_PAYLOAD), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response("Not found", { status: 404 });
	};

	try {
		const report = await adapter.query(
			{
				actualProviderId: ANTIGRAVITY_PROVIDER_ID,
				headers: { Authorization: "Bearer ya29.test" },
				fingerprint: "test-fp",
				secrets: ["ya29.test"],
				accountEmail: "tester@example.com",
				model: {
					provider: ANTIGRAVITY_PROVIDER_ID,
					id: "gemini-3.8-flash",
					baseUrl: "https://daily-cloudcode-pa.googleapis.com",
				},
			},
			new AbortController().signal,
			5000,
		);

		assert.equal(report.providerId, ANTIGRAVITY_PROVIDER_ID);
		assert.equal(calls.length, 2);

		for (const call of calls) {
			assert.equal(call.headers["User-Agent"], ANTIGRAVITY_USER_AGENT);
			assert.equal(call.headers.Authorization, "Bearer ya29.test");
			assert.equal(call.headers.Accept, "application/json");
		}

		assert.equal(report.metrics.find((m) => m.id === "email")?.value, "tester@example.com");
		assert.equal(report.metrics.find((m) => m.id === "plan")?.value, "Google AI Pro");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Antigravity quota falls back across official origins", async () => {
	const adapter = adapterForProvider(ANTIGRAVITY_PROVIDER_ID);
	assert.ok(adapter);
	const calls: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		const url = String(input);
		calls.push(url);
		if (
			url ===
			"https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
		) {
			return new Response("unavailable", {
				status: 503,
				statusText: "Service Unavailable",
			});
		}
		if (
			url ===
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary"
		) {
			return new Response("missing", { status: 404, statusText: "Not Found" });
		}
		if (url.includes("retrieveUserQuotaSummary")) {
			return new Response(JSON.stringify(FIXTURE_QUOTA_SUMMARY), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
			return new Response(JSON.stringify(FIXTURE_PLAN_PAYLOAD), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response("Not found", { status: 404 });
	};

	try {
		const report = await adapter.query(
			antigravityAuth(),
			new AbortController().signal,
			5000,
		);
		assert.equal(report.metrics.find((metric) => metric.id === "plan")?.value, "Google AI Pro");
		assert.deepEqual(calls, [
			"https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
			"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
			"https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Antigravity quota does not retry an unauthorized token", async () => {
	const adapter = adapterForProvider(ANTIGRAVITY_PROVIDER_ID);
	assert.ok(adapter);
	const calls: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		calls.push(String(input));
		return new Response("no", { status: 401, statusText: "Unauthorized" });
	};
	try {
		await assert.rejects(adapter.query(antigravityAuth(), new AbortController().signal, 5000));
		assert.equal(calls.length, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Antigravity adapter rejects invalid origins", async () => {
	const adapter = adapterForProvider(ANTIGRAVITY_PROVIDER_ID);
	assert.ok(adapter);

	const customContext = {
		model: {
			provider: ANTIGRAVITY_PROVIDER_ID,
			id: "gemini-3.8-flash",
			baseUrl: "https://untrusted-proxy.example.com",
		},
		modelRegistry: {
			getAvailable: () => [],
			getAll: () => [],
			isUsingOAuth: () => true,
			getProviderAuth: async () => ({
				auth: {
					apiKey: "secret",
					headers: {},
					baseUrl: "https://untrusted-proxy.example.com",
				},
			}),
		},
	};

	await assert.rejects(
		resolveUsageAuth(customContext as any, adapter),
		(err: Error) => {
			assert.equal(err.name, "Error");
			assert.match(err.message, /custom provider credential/u);
			return true;
		},
	);
});

test("does not classify a Gemini pool from description text", () => {
	const report = normalizeAntigravityUsage(
		{
			groups: [
				{
					displayName: "Gemini Models",
					description: "Separate from Claude and GPT pools",
					buckets: [
						{
							bucketId: "gemini-5h",
							displayName: "Five Hour Limit Remaining",
							window: "5h",
							remainingFraction: 1,
						},
					],
				},
			],
		},
		1,
	);
	assert.equal(report.buckets[0]?.groupId, ANTIGRAVITY_DEFAULT_GROUP_ID);
});

test("throws error when payload is empty or has no groups/buckets", () => {
	assert.throws(
		() => normalizeAntigravityUsage({}, Date.now()),
		/was not an object/u,
	);
	assert.throws(
		() => normalizeAntigravityUsage({ groups: [] }, Date.now()),
		/no displayable usage data/u,
	);
});
