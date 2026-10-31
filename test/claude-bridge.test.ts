import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { formatProviderState, formatUsageReport } from "../src/format.ts";
import {
	normalizeClaudeRateLimitHeaders,
	settleClaudeReport,
} from "../src/providers/claude-bridge.ts";
import { buildUsageStatusEvent, formatUsageStatusline } from "../src/status.ts";

const capturedAt = Date.parse("2026-10-31T14:44:00Z");
const model = { provider: "claude-bridge", id: "claude-haiku-4-5" };

// Captured from pi-claude-bridge 0.9.3 with Claude Code 2.1.311.
const bridgeHeaders = {
	"anthropic-ratelimit-unified-status": "allowed",
	"anthropic-ratelimit-unified-reset": "1793466000",
	"anthropic-ratelimit-unified-representative-claim": "five_hour",
	"anthropic-ratelimit-unified-overage-status": "rejected",
	"anthropic-ratelimit-unified-5h-utilization": "0.2",
	"anthropic-ratelimit-unified-5h-reset": "1793466000",
	"anthropic-ratelimit-unified-7d-utilization": "0.13",
	"anthropic-ratelimit-unified-7d-reset": "1793880000",
};

test("normalizes bridge rate-limit headers into 5h and weekly windows", () => {
	const report = normalizeClaudeRateLimitHeaders(bridgeHeaders, capturedAt);
	assert.ok(report);
	assert.equal(report.providerId, "claude-bridge");
	assert.deepEqual(
		report.buckets.map((bucket) => [
			bucket.id,
			Math.round(bucket.used ?? -1),
			Math.round(bucket.remaining ?? -1),
			bucket.windowMinutes,
			bucket.resetsAt,
		]),
		[
			["five-hour", 20, 80, 300, 1_793_466_000],
			["seven-day", 13, 87, 10_080, 1_793_880_000],
		],
	);
	const nowMs = Date.parse("2026-10-31T14:45:00Z");
	assert.equal(
		formatUsageStatusline(report, model, "remaining", nowMs),
		"5h 80% ↻2h15m · 1w 87% ↻4d21h",
	);
	assert.equal(
		formatUsageStatusline(report, model, "used", nowMs),
		"5h 20% ↻2h15m · 1w 13% ↻4d21h",
	);
	const event = buildUsageStatusEvent(report, model, "remaining", nowMs);
	assert.equal(event.status, "ready");
	assert.deepEqual(
		event.status === "ready" ? event.windows.map((window) => window.kind) : [],
		["hourly", "weekly"],
	);
});

test("matches header names case-insensitively", () => {
	const report = normalizeClaudeRateLimitHeaders(
		{ "Anthropic-RateLimit-Unified-7d-Utilization": "0.5" },
		capturedAt,
	);
	assert.deepEqual(report?.buckets.map((bucket) => bucket.id), ["seven-day"]);
	assert.equal(report?.buckets[0]?.resetsAt, undefined);
});

test("ignores responses without usable utilization", () => {
	assert.equal(normalizeClaudeRateLimitHeaders({}, capturedAt), undefined);
	assert.equal(
		normalizeClaudeRateLimitHeaders(
			{
				"content-type": "text/event-stream",
				"anthropic-ratelimit-unified-status": "allowed",
				"anthropic-ratelimit-unified-reset": "1793466000",
			},
			capturedAt,
		),
		undefined,
	);
	// A real Anthropic response delivered under claude-bridge after a model switch.
	assert.equal(
		normalizeClaudeRateLimitHeaders(
			{ ...bridgeHeaders, "content-type": "text/event-stream" },
			capturedAt,
		),
		undefined,
	);
	for (const value of ["", "abc", "-0.1", "20", "Infinity"]) {
		assert.equal(
			normalizeClaudeRateLimitHeaders(
				{ "anthropic-ratelimit-unified-5h-utilization": value },
				capturedAt,
			),
			undefined,
			`utilization ${JSON.stringify(value)}`,
		);
	}
});

test("drops reset times that are not Unix seconds", () => {
	const report = normalizeClaudeRateLimitHeaders(
		{
			"anthropic-ratelimit-unified-5h-utilization": "0.4",
			"anthropic-ratelimit-unified-5h-reset": "1793466000000",
		},
		capturedAt,
	);
	assert.equal(report?.buckets[0]?.resetsAt, undefined);
});

test("settles windows whose reset passed after the observation", () => {
	const report = normalizeClaudeRateLimitHeaders(bridgeHeaders, capturedAt);
	assert.ok(report);
	const settled = settleClaudeReport(report, 1_793_466_000_000);
	const [fiveHour, weekly] = settled.buckets;
	assert.equal(fiveHour?.used, 0);
	assert.equal(fiveHour?.remaining, 100);
	assert.equal(fiveHour?.resetsAt, undefined);
	assert.equal(weekly?.resetsAt, 1_793_880_000);
	assert.equal(Math.round(weekly?.used ?? -1), 13);
	// The stored observation itself is never rewritten.
	assert.equal(report.buckets[0]?.resetsAt, 1_793_466_000);
	assert.equal(settled.notes?.length, 1);
	assert.match(
		formatUsageReport(settled, "remaining"),
		/^Claude \(Claude Code\)\n  5h Window .*100% left\n  1w Window .*87% left · resets /u,
	);
});

test("explains a Claude session that has not reported usage yet", () => {
	assert.equal(
		formatProviderState({
			providerId: "claude-bridge",
			providerName: "Claude (Claude Code)",
			status: "pending",
			message: "send a message first.",
		}),
		"Claude (Claude Code)\n  Waiting: send a message first.",
	);
});

// Keep the extension offline and independent of a globally installed Pi.
const sdkUrl = "data:text/javascript," + encodeURIComponent(`
export const CONFIG_DIR_NAME = '.pi';
export const readStoredCredential = () => undefined;
export const getAgentDir = () => '/nonexistent/pi-claude-test';
`);
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@earendil-works/pi-coding-agent"
		? { url: sdkUrl, shortCircuit: true } : next(specifier, context);
} });

test("extension shows observed Claude usage without any request", async () => {
	const { default: extension } = await import("../src/usage.ts");
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	extension({
		on: (name: string, handler: Function) => { handlers.set(name, handler); },
		registerCommand: (name: string, command: { handler: Function }) => { commands.set(name, command); },
		events: { emit: () => {} },
	} as never);
	const statuses: (string | undefined)[] = [], notices: string[] = [];
	const ctx = {
		model: model as { provider: string; id: string },
		hasUI: true, cwd: "/nonexistent/pi-claude-test", isProjectTrusted: () => false,
		modelRegistry: { getAll: () => [], getAvailable: () => [] },
		ui: {
			setStatus: (_key: string, value: string | undefined) => { statuses.push(value); },
			notify: (text: string) => { notices.push(text); },
		},
	};
	const settle = () => new Promise(resolve => setImmediate(resolve));
	const emit = async (name: string, event: object = {}) => { await handlers.get(name)!(event, ctx); await settle(); };
	const usage = async () => { await commands.get("usage")!.handler("", ctx); return notices.at(-1); };
	const original = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async () => { requests += 1; return new Response("{}"); };
	try {
		await emit("session_start");
		assert.match(await usage() ?? "", /Waiting: /);
		assert.equal(statuses.at(-1), undefined);

		await emit("after_provider_response", { status: 200, headers: { ...bridgeHeaders, "content-type": "text/event-stream" } });
		assert.match(await usage() ?? "", /Waiting: /);

		await emit("after_provider_response", { status: 200, headers: bridgeHeaders });
		assert.match(statuses.at(-1) ?? "", /^5h 80% .* 1w 87% /);
		assert.ok(!statuses.includes("usage …"));

		// A bridge report arriving after the switch away must not overwrite the observation.
		ctx.model = { provider: "unknown-provider", id: "other" };
		await emit("model_select", { model: ctx.model });
		assert.equal(statuses.at(-1), undefined);
		await emit("after_provider_response", { status: 200, headers: { ...bridgeHeaders, "anthropic-ratelimit-unified-5h-utilization": "0.9" } });
		ctx.model = model;
		await emit("model_select", { model: ctx.model });
		assert.match(statuses.at(-1) ?? "", /^5h 80% /);
		assert.match(await usage() ?? "", /5h Window .* 80% left/);

		await emit("session_shutdown");
		assert.equal(statuses.at(-1), undefined);
		assert.equal(requests, 0);
	} finally {
		globalThis.fetch = original;
		// Clears the refresh timer, so a failed assertion cannot hang the run.
		await handlers.get("session_shutdown")!({}, ctx);
	}
});
