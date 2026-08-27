import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageReport, formatUsageStatusline } from "../src/format.ts";
import { buildUsageStatusEvent } from "../src/status.ts";
import { normalizeCodexUsage } from "../src/providers/codex.ts";
import {
	normalizeGrokBilling,
	normalizeGrokIdentity,
} from "../src/providers/grok.ts";
import { normalizeKimiUsage } from "../src/providers/kimi.ts";
import { normalizeOpenCodeGoUsage } from "../src/providers/opencode-go.ts";

const capturedAt = Date.parse("2026-08-27T10:00:00Z");

test("normalizes Codex windows and earned resets", () => {
	const report = normalizeCodexUsage(
		{
			plan_type: "pro",
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
	);
	assert.equal(report.buckets[0]?.remaining, 75);
	assert.equal(report.buckets[1]?.remaining, 50);
	assert.equal(
		report.metrics.find((metric) => metric.id === "reset-credits")?.value,
		2,
	);
	assert.equal(formatUsageStatusline(report), "5h 75% · 1w 50%");
	const panel = formatUsageReport(report);
	assert.match(
		panel,
		/Shared Across Models:\n    5h Window +[█░]{12} +75% left · resets \d{2}\/\d{2} \d{2}:\d{2}\n    1w Window +[█░]{12} +50% left/u,
	);
	assert.match(panel, /gpt-5\.6-spark:\n    5h Window +[█░]{12} +10% left/u);
	assert.ok(
		panel.indexOf("Shared Across Models:") < panel.indexOf("gpt-5.6-spark:"),
	);
	assert.match(panel, /Account:\n    Resets Left +2/u);
	assert.equal(
		formatUsageStatusline(report, {
			provider: "openai-codex",
			id: "gpt-5.6-spark",
			name: "GPT-5.6 Spark Codex",
		}),
		"5h 10%",
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
});

test("verifies Grok identity before normalizing billing", () => {
	assert.equal(normalizeGrokIdentity({ userId: "user_123" }), "user_123");
	assert.throws(() => normalizeGrokIdentity({ userId: "bad\nuser" }));
	const report = normalizeGrokBilling(
		{
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
		},
		capturedAt,
	);
	assert.equal(report.buckets[0]?.remaining, 60);
	assert.equal(
		report.metrics.find((metric) => metric.id === "prepaid-balance")?.value,
		2.5,
	);
	assert.equal(report.buckets[0]?.period, "weekly");
	assert.equal(formatUsageStatusline(report), "1w 60%");
	assert.match(
		formatUsageReport(report),
		/1w Window +[█░]{12} +60% left · resets \d{2}\/\d{2} \d{2}:\d{2}/u,
	);
});
