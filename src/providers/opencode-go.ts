// Adapted from @narumitw/pi-usage@0.53.0 (MIT).
import { sanitizeDisplayText } from "../core.ts";
import type { UsageBucket, UsageReport } from "../types.ts";

const WINDOWS = [
	{ key: "rolling", label: "Rolling", windowMinutes: 300 },
	{ key: "weekly", label: "Weekly", windowMinutes: 10_080 },
	{ key: "monthly", label: "Monthly", windowMinutes: 43_200 },
] as const;

export function normalizeOpenCodeGoUsage(
	payload: unknown,
	capturedAt: number,
): UsageReport {
	const root = asObject(payload);
	const usage = asObject(root?.usage);
	if (!usage) throw new Error("OpenCode Go usage response was not an object.");
	const buckets: UsageBucket[] = [];
	const notes: string[] = [];
	for (const window of WINDOWS) {
		const raw = asObject(usage[window.key]);
		if (!raw) continue;
		const status = asString(raw.status);
		if (status !== "ok" && status !== "rate-limited") {
			notes.push(
				`${window.label} window unavailable (${status ?? "unknown status"}).`,
			);
			continue;
		}
		const used = asNonnegativeNumber(raw.percent);
		if (used === undefined) continue;
		const resetsAt = asEpochSeconds(raw.resetsAt);
		buckets.push({
			id: window.key,
			label: `${window.label} window`,
			used,
			remaining: 100 - clampPercent(used),
			limit: 100,
			unit: "percent",
			windowMinutes: window.windowMinutes,
			...(resetsAt === undefined ? {} : { resetsAt }),
		});
	}
	if (buckets.length === 0) {
		throw new Error(
			"OpenCode Go usage endpoint returned no displayable usage data.",
		);
	}
	return {
		providerId: "opencode-go",
		providerName: "OpenCode Go",
		capturedAt,
		source: "opencode-go-usage",
		semantics: { kind: "consumer-subscription", label: "OpenCode Go plan usage" },
		buckets,
		metrics: [],
		...(notes.length > 0 ? { notes } : {}),
	};
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string"
		? sanitizeDisplayText(value, 80) || undefined
		: undefined;
}

function asNonnegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function asEpochSeconds(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}
