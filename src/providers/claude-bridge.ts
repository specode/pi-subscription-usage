// pi-claude-bridge has no usage endpoint Pi can call: Claude Code reports plan
// usage as rate_limit_event messages, which the bridge replays to Pi as
// `anthropic-ratelimit-unified-*` headers on after_provider_response.
// This module turns those headers into a report; nothing here sends a request.
import type { UsageBucket, UsageReport } from "../types.ts";

export const CLAUDE_BRIDGE_PROVIDER_ID = "claude-bridge";

const HEADER_PREFIX = "anthropic-ratelimit-unified-";
// Observed: utilization is a 0..1 fraction. Anything far above 1 means the
// scale changed, and a guessed percentage would be worse than none.
const MAX_UTILIZATION = 1.5;
// Unix seconds; a millisecond value would land past this bound.
const MAX_EPOCH_SECONDS = 10_000_000_000;

const CLAUDE_WINDOWS: readonly {
	abbreviation: string;
	id: string;
	label: string;
	windowMinutes: number;
}[] = [
	{ abbreviation: "5h", id: "five-hour", label: "5h window", windowMinutes: 300 },
	{ abbreviation: "7d", id: "seven-day", label: "Weekly window", windowMinutes: 10_080 },
];

/** Undefined when the headers carry no usable window, so a non-Claude response leaves the last observation alone. */
export function normalizeClaudeRateLimitHeaders(
	headers: Record<string, string | undefined>,
	capturedAt: number,
): UsageReport | undefined {
	const lookup = new Map(
		Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
	);
	// The event names no provider, and a model switch mid-stream can deliver a
	// real Anthropic response under claude-bridge with the same header names.
	// Only the bridge's synthetic response consists of nothing but these.
	if ([...lookup.keys()].some((name) => !name.startsWith(HEADER_PREFIX))) {
		return undefined;
	}
	const buckets: UsageBucket[] = [];
	for (const window of CLAUDE_WINDOWS) {
		const utilization = parseNumber(
			lookup.get(`${HEADER_PREFIX}${window.abbreviation}-utilization`),
		);
		if (
			utilization === undefined ||
			utilization < 0 ||
			utilization > MAX_UTILIZATION
		) {
			continue;
		}
		const used = utilization * 100;
		const resetsAt = parseNumber(
			lookup.get(`${HEADER_PREFIX}${window.abbreviation}-reset`),
		);
		buckets.push({
			id: window.id,
			label: window.label,
			used,
			remaining: Math.max(0, 100 - used),
			unit: "percent",
			windowMinutes: window.windowMinutes,
			...(resetsAt !== undefined && resetsAt > 0 && resetsAt < MAX_EPOCH_SECONDS
				? { resetsAt: Math.floor(resetsAt) }
				: {}),
		});
	}
	if (buckets.length === 0) return undefined;
	return {
		providerId: CLAUDE_BRIDGE_PROVIDER_ID,
		providerName: "Claude (Claude Code)",
		capturedAt,
		source: "claude-code-rate-limit-event",
		semantics: {
			kind: "consumer-subscription",
			label: "Claude subscription limits",
		},
		buckets,
		metrics: [],
	};
}

/**
 * Claude Code only reports usage after a request, so an observation outlives
 * its windows. A window whose reset has passed starts empty; showing the old
 * percentage would overstate usage until the next response.
 */
export function settleClaudeReport(
	report: UsageReport,
	nowMs: number,
): UsageReport {
	const nowSeconds = nowMs / 1_000;
	return {
		...report,
		buckets: report.buckets.map((bucket) => {
			if (bucket.resetsAt === undefined || bucket.resetsAt > nowSeconds) {
				return bucket;
			}
			const { resetsAt: _expired, ...rest } = bucket;
			return { ...rest, used: 0, remaining: 100 };
		}),
		notes: [`Observed after the last Claude response at ${formatClock(report.capturedAt)}; Claude Code reports usage only with its responses.`],
	};
}

function parseNumber(value: string | undefined): number | undefined {
	if (value === undefined || !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function formatClock(epochMs: number): string {
	const date = new Date(epochMs);
	if (Number.isNaN(date.getTime())) return "an unknown time";
	const hour = date.getHours().toString().padStart(2, "0");
	const minute = date.getMinutes().toString().padStart(2, "0");
	return `${hour}:${minute}`;
}
