// Adapted from @sumhou/pi-kimi-usage@1.0.1 (MIT).
import type { UsageBucket, UsageReport } from "../types.ts";

export function normalizeKimiUsage(
	payload: unknown,
	capturedAt: number,
): UsageReport {
	const root = asObject(payload);
	if (!root) throw new Error("Kimi usage response was not an object.");
	const buckets: UsageBucket[] = [];
	const weekly = parseQuota(root.usage);
	if (weekly) {
		buckets.push({
			id: "weekly",
			label: "Weekly window",
			...weekly,
			unit: "count",
			windowMinutes: 10_080,
		});
	}
	const limits = Array.isArray(root.limits) ? root.limits : [];
	for (const [index, item] of limits.entries()) {
		const entry = asObject(item);
		const detail = parseQuota(entry?.detail ?? entry);
		if (!detail) continue;
		const window = asObject(entry?.window);
		const windowInfo = parseWindow(window);
		buckets.push({
			id: `rolling-${index}`,
			label: `${windowInfo.label} window`,
			...detail,
			unit: "count",
			...(windowInfo.minutes === undefined
				? {}
				: { windowMinutes: windowInfo.minutes }),
		});
	}
	if (buckets.length === 0) {
		throw new Error("Kimi usage endpoint returned no displayable quota data.");
	}
	return {
		providerId: "kimi-coding",
		providerName: "Kimi Coding",
		capturedAt,
		source: "kimi-coding-usage",
		semantics: { kind: "consumer-subscription", label: "Kimi Coding plan usage" },
		buckets,
		metrics: [],
	};
}

function parseQuota(
	value: unknown,
): Omit<UsageBucket, "id" | "label" | "unit"> | undefined {
	const record = asObject(value);
	if (!record) return undefined;
	const limit = asFiniteNumber(record.limit);
	const used = asFiniteNumber(record.used);
	const remaining = asFiniteNumber(record.remaining);
	if (
		limit === undefined ||
		used === undefined ||
		remaining === undefined ||
		limit <= 0 ||
		used < 0 ||
		remaining < 0
	) {
		return undefined;
	}
	const resetsAt = parseDate(record.resetTime);
	return {
		used,
		remaining,
		limit,
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

function parseWindow(value: Record<string, unknown> | undefined): {
	label: string;
	minutes?: number;
} {
	const duration = asFiniteNumber(value?.duration);
	const unit = value?.timeUnit;
	if (duration === undefined || duration <= 0 || typeof unit !== "string") {
		return { label: "Rolling" };
	}
	if (unit === "TIME_UNIT_SECOND") {
		return { label: `${duration}s`, minutes: duration / 60 };
	}
	if (unit === "TIME_UNIT_MINUTE") {
		return {
			label: duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`,
			minutes: duration,
		};
	}
	if (unit === "TIME_UNIT_HOUR")
		return { label: `${duration}h`, minutes: duration * 60 };
	if (unit === "TIME_UNIT_DAY")
		return { label: `${duration}d`, minutes: duration * 1_440 };
	return { label: "Rolling" };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDate(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}
