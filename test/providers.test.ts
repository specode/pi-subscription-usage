import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageReport, formatUsageStatusline } from "../src/format.ts";
import { SUPPORTED_ADAPTERS } from "../src/query.ts";
import { buildUsageStatusEvent } from "../src/status.ts";
import {
	codexEmailFromAuthorization,
	normalizeCodexUsage,
} from "../src/providers/codex.ts";
import type { ResolvedUsageAuth } from "../src/types.ts";
import {
	grokRequestHeaders,
	normalizeGrokBilling,
	normalizeGrokIdentity,
	requiresGrokMonthlyQuota,
	shouldProbeGrokMonthly,
} from "../src/providers/grok.ts";
import { normalizeKimiUsage } from "../src/providers/kimi.ts";
import { normalizeOpenCodeGoUsage } from "../src/providers/opencode-go.ts";

const capturedAt = Date.parse("2026-08-27T10:00:00Z");

test("normalizes Codex windows and earned resets", () => {
	const report = normalizeCodexUsage(
		{
			plan_type: "pro",
			credits: { has_credits: false },
			rate_limit: {
				primary_window: {
					used_percent: 25,
					limit_window_seconds: 18_000,
					reset_at: 1_800_000_000,
				},
				secondary_window: {
					used_percent: 50,
					limit_window_seconds: 604_800,
				},
			},
			rate_limit_reset_credits: { available_count: 2 },
			additional_rate_limits: [
				{
					metered_feature: "spark",
					limit_name: "gpt-5.6-spark",
					rate_limit: {
						primary_window: {
							used_percent: 90,
							limit_window_seconds: 18_000,
						},
					},
				},
			],
		},
		capturedAt,
		"User@Example.com",
	);
	assert.equal(report.defaultGroupId, "codex");
	assert.equal(report.buckets[0]?.remaining, 75);
	assert.equal(report.buckets[1]?.remaining, 50);
	assert.deepEqual(
		report.metrics.map((metric) => metric.id),
		["email", "plan", "reset-credits", "credits"],
	);
	assert.equal(
		report.metrics.find((metric) => metric.id === "reset-credits")?.value,
		2,
	);
	assert.equal(
		report.metrics.find((metric) => metric.id === "email")?.value,
		"user@example.com",
	);
	assert.equal(
		report.metrics.find((metric) => metric.id === "plan")?.value,
		"Pro",
	);
	assert.equal(formatUsageStatusline(report), "5h 75% · 1w 50%");
	assert.equal(
		formatUsageStatusline(report, undefined, "used"),
		"5h 25% · 1w 50%",
	);
	const panel = formatUsageReport(report);
	assert.match(
		panel,
		/Shared Across Models:\n {4}5h Window +[█░]{12} +75% left · resets \d{2}\/\d{2} \d{2}:\d{2}\n {4}1w Window +[█░]{12} +50% left/u,
	);
	assert.match(panel, /gpt-5\.6-spark:\n {4}5h Window +[█░]{12} +10% left/u);
	assert.match(
		formatUsageReport(report, "used"),
		/Shared Across Models:\n {4}5h Window +[█░]{12} +25% used/u,
	);
	assert.ok(
		panel.indexOf("Shared Across Models:") < panel.indexOf("gpt-5.6-spark:"),
	);
	assert.match(panel, /Account:\n {4}Email +user@example\.com/u);
	assert.match(panel, /Plan +Pro/u);
	assert.equal(
		formatUsageStatusline(report, {
			provider: "openai-codex",
			id: "gpt-5.6-spark",
			name: "GPT-5.6 Spark Codex",
		}),
		"5h 10%",
	);
	assert.equal(
		formatUsageStatusline(
			{ ...report, providerId: "provider-neutral-fixture" },
			{
				provider: "provider-neutral-fixture",
				id: "gpt-5.6-spark",
				name: "GPT-5.6 Spark",
			},
		),
		"5h 10%",
	);
	assert.equal(
		formatUsageStatusline({
			...report,
			defaultGroupId: undefined,
			buckets: report.buckets.map((bucket) => ({
				...bucket,
				modelKeys: undefined,
			})),
		}),
		"5h 75% · 5h 10% · 1w 50%",
	);
});

test("extracts the Codex email from the OAuth access token", () => {
	const nestedPayload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/profile": { email: "User@Example.com" },
		}),
	).toString("base64url");
	assert.equal(
		codexEmailFromAuthorization(`Bearer header.${nestedPayload}.signature`),
		"user@example.com",
	);

	const fallbackPayload = Buffer.from(
		JSON.stringify({ email: "fallback@example.com" }),
	).toString("base64url");
	assert.equal(
		codexEmailFromAuthorization(`Bearer header.${fallbackPayload}.signature`),
		"fallback@example.com",
	);
	assert.equal(codexEmailFromAuthorization("Bearer malformed"), undefined);
	assert.equal(codexEmailFromAuthorization(undefined), undefined);
});

test("clamps invalid Codex percentages while preserving quota invariants", () => {
	const overLimit = normalizeCodexUsage(
		{ rate_limit: { primary_window: { used_percent: 125 } } },
		capturedAt,
	).buckets[0];
	assert.deepEqual(
		[overLimit?.used, overLimit?.remaining, overLimit?.limit],
		[100, 0, 100],
	);

	const belowZero = normalizeCodexUsage(
		{ rate_limit: { primary_window: { used_percent: -10 } } },
		capturedAt,
	).buckets[0];
	assert.deepEqual(
		[belowZero?.used, belowZero?.remaining, belowZero?.limit],
		[0, 100, 100],
	);
});

test("normalizes OpenCode Go rolling windows", () => {
	const report = normalizeOpenCodeGoUsage(
		{
			usage: {
				rolling: { status: "ok", percent: 12, resetsAt: "2026-08-27T12:00:00Z" },
				weekly: { status: "rate-limited", percent: 100 },
				monthly: { status: "unknown", percent: 3 },
			},
		},
		capturedAt,
	);
	assert.deepEqual(
		report.buckets.map((bucket) => [bucket.id, bucket.remaining]),
		[
			["rolling", 88],
			["weekly", 0],
		],
	);
	assert.equal(report.notes?.length, 1);
	assert.deepEqual(
		report.buckets.map((bucket) => bucket.windowMinutes),
		[300, 10_080],
	);
	assert.equal(formatUsageStatusline(report), "5h 88% · 1w 0%");
});

test("clamps invalid OpenCode Go percentages", () => {
	const report = normalizeOpenCodeGoUsage(
		{ usage: { rolling: { status: "ok", percent: 125 } } },
		capturedAt,
	);
	assert.deepEqual(
		[report.buckets[0]?.used, report.buckets[0]?.remaining],
		[100, 0],
	);
});

test("builds provider-neutral status data in 5h/1w/1m order", () => {
	const report = normalizeOpenCodeGoUsage(
		{
			usage: {
				monthly: { status: "ok", percent: 30 },
				weekly: { status: "ok", percent: 20 },
				rolling: { status: "ok", percent: 10 },
			},
		},
		capturedAt,
	);
	report.buckets.reverse();
	const event = buildUsageStatusEvent(report);
	assert.equal(event.status, "ready");
	if (event.status !== "ready") return;
	assert.deepEqual(
		event.windows.map((window) => window.label),
		["5h", "1w", "1m"],
	);
	assert.equal(event.displayMode, "remaining");
	assert.deepEqual(
		event.windows.map((window) => [
			window.remainingPercent,
			window.usedPercent,
			window.displayPercent,
		]),
		[
			[90, 10, 90],
			[80, 20, 80],
			[70, 30, 70],
		],
	);
	const usedEvent = buildUsageStatusEvent(report, undefined, "used");
	assert.equal(usedEvent.status, "ready");
	if (usedEvent.status !== "ready") return;
	assert.equal(usedEvent.displayMode, "used");
	assert.deepEqual(
		usedEvent.windows.map((window) => window.displayPercent),
		[10, 20, 30],
	);
	assert.equal(formatUsageStatusline(report), "5h 90% · 1w 80% · 1m 70%");
});

test("normalizes Kimi weekly and rolling quotas", () => {
	const report = normalizeKimiUsage(
		{
			usage: {
				limit: 1_000,
				used: 250,
				remaining: 750,
				resetTime: "2026-09-01T00:00:00Z",
			},
			limits: [
				{
					window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
					detail: {
						limit: 100,
						used: 20,
						remaining: 80,
						resetTime: "2026-08-27T15:00:00Z",
					},
				},
			],
		},
		capturedAt,
	);
	assert.equal(report.buckets[0]?.id, "weekly");
	assert.equal(report.buckets[1]?.label, "5h window");
	assert.equal(report.buckets[1]?.remaining, 80);
	assert.equal(formatUsageStatusline(report), "5h 80% · 1w 75%");
	assert.equal(
		formatUsageStatusline(report, undefined, "used"),
		"5h 20% · 1w 25%",
	);
	assert.match(
		formatUsageReport(report, "used"),
		/5h Window +[█░]{12} +20% used · resets/u,
	);
	assert.match(
		formatUsageReport(report, "used"),
		/1w Window +[█░]{12} +25% used · 250\/1000/u,
	);
});

test("verifies Grok identity before normalizing billing", () => {
	const requestHeaders = grokRequestHeaders("user_123");
	assert.equal(requestHeaders["X-XAI-Token-Auth"], "xai-grok-cli");
	assert.equal(requestHeaders["x-grok-client-version"], "0.1.0");
	assert.equal(requestHeaders["x-userid"], "user_123");
	assert.ok(
		["interactive", "headless"].includes(requestHeaders["x-grok-client-mode"]),
	);
	assert.equal(normalizeGrokIdentity({ userId: "user_123" }), "user_123");
	assert.throws(() => normalizeGrokIdentity({ userId: "bad\nuser" }));
	const credits = {
		subscriptionTier: "SuperGrok",
		onDemandEnabled: false,
		config: {
			creditUsagePercent: 40,
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				end: "2026-09-01T00:00:00Z",
			},
			used: { val: 400 },
			monthlyLimit: { val: 1_000 },
			prepaidBalance: { val: 250 },
		},
	};
	const report = normalizeGrokBilling(credits, capturedAt);
	assert.equal(report.buckets[0]?.remaining, 60);
	assert.equal(report.buckets[0]?.period, "weekly");
	assert.equal(report.buckets[0]?.id, "weekly");
	assert.equal(shouldProbeGrokMonthly(credits), false);
	assert.equal(
		report.metrics.find((metric) => metric.id === "prepaid-balance")?.value,
		2.5,
	);
	assert.equal(
		report.metrics.find((metric) => metric.id === "plan")?.value,
		"SuperGrok",
	);
	assert.equal(
		report.metrics.find((metric) => metric.id === "on-demand")?.value,
		"off",
	);
	assert.equal(report.notes, undefined);
	assert.equal(formatUsageStatusline(report), "1w 60%");
	const panel = formatUsageReport(report);
	assert.match(
		panel,
		/1w Window +[█░]{12} +60% left · resets \d{2}\/\d{2} \d{2}:\d{2}/u,
	);
	assert.match(panel, /Plan +SuperGrok/u);
	assert.match(panel, /On-Demand +off/u);
});

test("maps unified Grok monthly quota onto the shared 1m window", () => {
	const credits = {
		subscriptionTier: "SuperGrok",
		config: {
			isUnifiedBillingUser: true,
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				start: "2026-08-20T10:00:00Z",
				end: "2026-08-27T12:00:00Z",
			},
			onDemandCap: { val: 0 },
			onDemandUsed: { val: 0 },
			prepaidBalance: { val: 0 },
		},
	};
	const monthly = {
		config: {
			monthlyLimit: { val: 15_000 },
			used: { val: 10_548 },
			billingPeriodStart: "2026-08-01T00:00:00Z",
			billingPeriodEnd: "2026-09-01T00:00:00Z",
		},
	};
	assert.equal(shouldProbeGrokMonthly(credits), true);
	const report = normalizeGrokBilling(credits, capturedAt, monthly);
	assert.equal(report.buckets[0]?.id, "monthly");
	assert.equal(report.buckets[0]?.period, "monthly");
	assert.equal(Math.round(report.buckets[0]?.used ?? 0), 70);
	assert.equal(formatUsageStatusline(report), "1m 30%");
	assert.match(
		formatUsageReport(report),
		/1m Window +[█░]{12} +30% left · resets \d{2}\/\d{2} \d{2}:\d{2}/u,
	);
	assert.equal(
		report.metrics.find((metric) => metric.id === "included-used")?.value,
		105.48,
	);
});

test("keeps explicit Grok weekly percent and adds a monthly window when both exist", () => {
	const credits = {
		config: {
			isUnifiedBillingUser: true,
			creditUsagePercent: 20,
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				end: "2026-09-01T00:00:00Z",
			},
		},
	};
	const monthly = {
		config: {
			monthlyLimit: { val: 1_000 },
			used: { val: 400 },
			billingPeriodStart: "2026-08-01T00:00:00Z",
			billingPeriodEnd: "2026-09-01T00:00:00Z",
		},
	};
	const report = normalizeGrokBilling(credits, capturedAt, monthly);
	assert.equal(formatUsageStatusline(report), "1w 80% · 1m 60%");
	assert.match(
		formatUsageReport(report),
		/1w Window +[█░]{12} +80% left · resets \d{2}\/\d{2} \d{2}:\d{2}\n {2}1m Window +[█░]{12} +60% left · resets \d{2}\/\d{2} \d{2}:\d{2}/u,
	);
});

test("falls back to Grok included cents when weekly percent is omitted", () => {
	const credits = {
		config: {
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				end: "2026-09-01T00:00:00Z",
			},
			used: { val: 400 },
			monthlyLimit: { val: 1_000 },
		},
	};
	assert.equal(shouldProbeGrokMonthly(credits), false);
	const report = normalizeGrokBilling(credits, capturedAt);
	assert.equal(formatUsageStatusline(report), "1w 60%");
});

test("requires monthly quota when Grok weekly percent is omitted", () => {
	const credits = {
		config: {
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				start: "2026-08-20T10:00:00Z",
				end: "2026-09-01T00:00:00Z",
			},
		},
	};
	assert.equal(shouldProbeGrokMonthly(credits), true);
	assert.equal(requiresGrokMonthlyQuota(credits), true);
	assert.throws(
		() => normalizeGrokBilling(credits, capturedAt),
		/no displayable quota window/u,
	);
});

test("does not invent Grok weekly usage from a zero-limit monthly response", () => {
	const credits = {
		config: {
			isUnifiedBillingUser: true,
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				start: "2026-08-20T10:00:00Z",
				end: "2026-09-01T00:00:00Z",
			},
		},
	};
	assert.throws(
		() =>
			normalizeGrokBilling(credits, capturedAt, {
				config: {
					monthlyLimit: { val: 0 },
					used: { val: 500 },
				},
			}),
		/no displayable quota window/u,
	);
});

test("rejects Grok reports with metrics but no quota window", () => {
	const credits = {
		config: {
			isUnifiedBillingUser: true,
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				start: "2026-08-20T10:00:00Z",
				end: "2026-09-01T00:00:00Z",
			},
			prepaidBalance: { val: 250 },
		},
	};
	for (const monthly of [null, {}, { config: "bad" }]) {
		assert.throws(
			() => normalizeGrokBilling(credits, capturedAt, monthly),
			/no displayable quota window/u,
		);
	}
});

test("keeps Grok monthly cents as a 1m window even if currentPeriod is weekly", () => {
	const report = normalizeGrokBilling(
		{ config: { isUnifiedBillingUser: true } },
		capturedAt,
		{
			config: {
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					end: "2026-09-01T00:00:00Z",
				},
				monthlyLimit: { val: 1_000 },
				used: { val: 400 },
				billingPeriodStart: "2026-08-01T00:00:00Z",
				billingPeriodEnd: "2026-09-01T00:00:00Z",
			},
		},
	);
	assert.equal(report.buckets[0]?.id, "monthly");
	assert.equal(formatUsageStatusline(report), "1m 60%");
	assert.equal(formatUsageStatusline(report, undefined, "used"), "1m 40%");
});

test("maps cents-only Grok billing without a weekly period onto 1m", () => {
	const report = normalizeGrokBilling(
		{
			config: {
				used: { val: 400 },
				monthlyLimit: { val: 1_000 },
				billingPeriodStart: "2026-08-01T00:00:00Z",
				billingPeriodEnd: "2026-09-01T00:00:00Z",
			},
		},
		capturedAt,
	);
	assert.equal(formatUsageStatusline(report), "1m 60%");
});

test("Grok adapter probes monthly billing for unified accounts", async () => {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith("/v1/user")) {
			return jsonResponse({ userId: "user_123" });
		}
		if (url.includes("format=credits")) {
			return jsonResponse({
				config: {
					isUnifiedBillingUser: true,
					currentPeriod: {
						type: "USAGE_PERIOD_TYPE_WEEKLY",
						end: "2026-09-01T00:00:00Z",
					},
				},
			});
		}
		return jsonResponse({
			config: {
				monthlyLimit: { val: 15_000 },
				used: { val: 10_548 },
				billingPeriodStart: "2026-08-01T00:00:00Z",
				billingPeriodEnd: "2026-09-01T00:00:00Z",
			},
		});
	};
	try {
		const report = await requiredAdapter("xai").query(
			grokAuth(),
			new AbortController().signal,
			5_000,
		);
		assert.equal(formatUsageStatusline(report), "1m 30%");
		assert.deepEqual(calls, [
			"https://cli-chat-proxy.grok.com/v1/user",
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
			"https://cli-chat-proxy.grok.com/v1/billing",
		]);
	} finally {
		globalThis.fetch = original;
	}
});

test("Grok adapter surfaces a required monthly billing failure", async () => {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith("/v1/user")) {
			return jsonResponse({ userId: "user_123" });
		}
		if (url.includes("format=credits")) {
			return jsonResponse({
				config: {
					isUnifiedBillingUser: true,
					currentPeriod: {
						type: "USAGE_PERIOD_TYPE_WEEKLY",
						end: "2026-09-01T00:00:00Z",
					},
					prepaidBalance: { val: 250 },
				},
			});
		}
		return jsonResponse({ error: "unavailable" }, 500);
	};
	try {
		await assert.rejects(
			requiredAdapter("xai").query(
				grokAuth(),
				new AbortController().signal,
				5_000,
			),
			/Grok monthly billing endpoint returned 500/u,
		);
		assert.deepEqual(calls, [
			"https://cli-chat-proxy.grok.com/v1/user",
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
			"https://cli-chat-proxy.grok.com/v1/billing",
		]);
	} finally {
		globalThis.fetch = original;
	}
});

test("Grok adapter keeps reliable weekly usage when monthly billing fails", async () => {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith("/v1/user")) {
			return jsonResponse({ userId: "user_123" });
		}
		if (url.includes("format=credits")) {
			return jsonResponse({
				config: {
					isUnifiedBillingUser: true,
					creditUsagePercent: 40,
					currentPeriod: {
						type: "USAGE_PERIOD_TYPE_WEEKLY",
						end: "2026-09-01T00:00:00Z",
					},
				},
			});
		}
		return jsonResponse({ error: "unavailable" }, 500);
	};
	try {
		const report = await requiredAdapter("xai").query(
			grokAuth(),
			new AbortController().signal,
			5_000,
		);
		assert.equal(formatUsageStatusline(report), "1w 60%");
		assert.deepEqual(calls, [
			"https://cli-chat-proxy.grok.com/v1/user",
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
			"https://cli-chat-proxy.grok.com/v1/billing",
		]);
	} finally {
		globalThis.fetch = original;
	}
});

test("Grok adapter skips monthly billing for legacy weekly credits", async () => {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith("/v1/user")) {
			return jsonResponse({ userId: "user_123" });
		}
		return jsonResponse({
			config: {
				creditUsagePercent: 40,
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					end: "2026-09-01T00:00:00Z",
				},
			},
		});
	};
	try {
		const report = await requiredAdapter("xai").query(
			grokAuth(),
			new AbortController().signal,
			5_000,
		);
		assert.equal(formatUsageStatusline(report), "1w 60%");
		assert.deepEqual(calls, [
			"https://cli-chat-proxy.grok.com/v1/user",
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
		]);
	} finally {
		globalThis.fetch = original;
	}
});

function requiredAdapter(id: string) {
	const adapter = SUPPORTED_ADAPTERS.find((item) => item.id === id);
	if (!adapter) throw new Error(`Missing test adapter: ${id}`);
	return adapter;
}

function grokAuth(): ResolvedUsageAuth {
	return {
		actualProviderId: "xai-auth",
		headers: { Authorization: "Bearer fixture-token" },
		fingerprint: "fp",
		secrets: ["fixture-token"],
		model: { provider: "xai-auth", id: "grok-4" },
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
