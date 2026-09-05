import type { UsageBucket } from "./types.ts";

export type UsageDisplayMode = "remaining" | "used";

export const DEFAULT_USAGE_DISPLAY_MODE: UsageDisplayMode = "remaining";

export function usagePercentRemaining(bucket: UsageBucket): number | undefined {
	if (bucket.unit === "percent" && bucket.remaining !== undefined) {
		return clampPercent(bucket.remaining);
	}
	if (!bucket.limit || bucket.remaining === undefined) return undefined;
	return clampPercent((bucket.remaining / bucket.limit) * 100);
}

export function usagePercentUsed(bucket: UsageBucket): number | undefined {
	if (bucket.unit === "percent" && bucket.used !== undefined) {
		return clampPercent(bucket.used);
	}
	if (bucket.limit && bucket.used !== undefined) {
		return clampPercent((bucket.used / bucket.limit) * 100);
	}
	const remaining = usagePercentRemaining(bucket);
	return remaining === undefined ? undefined : 100 - remaining;
}

export function usagePercent(
	bucket: UsageBucket,
	mode: UsageDisplayMode,
): number | undefined {
	return mode === "used"
		? usagePercentUsed(bucket)
		: usagePercentRemaining(bucket);
}

export function usageAmount(
	bucket: UsageBucket,
	mode: UsageDisplayMode,
): number | undefined {
	const direct = mode === "used" ? bucket.used : bucket.remaining;
	if (direct !== undefined) return direct;
	if (bucket.limit === undefined) return undefined;
	const opposite = mode === "used" ? bucket.remaining : bucket.used;
	return opposite === undefined
		? undefined
		: Math.max(0, bucket.limit - opposite);
}

/** Integer presentation only; keep the original number for semantic decisions. */
export function formatUsagePercent(value: number): string {
	return String(Math.round(clampPercent(value)));
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}
