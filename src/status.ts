import {
	DEFAULT_USAGE_DISPLAY_MODE,
	usagePercent,
	usagePercentRemaining,
	usagePercentUsed,
	type UsageDisplayMode,
} from "./display.ts";
import type { UsageBucket, UsageModel, UsageReport } from "./types.ts";

export { usagePercentRemaining, usagePercentUsed } from "./display.ts";

export const USAGE_STATUS_EVENT = "subscription-usage/status/v1";

export type UsageStatusWindowKind =
	| "hourly"
	| "weekly"
	| "monthly"
	| "rolling"
	| "quota";

export interface UsageStatusWindow {
	kind: UsageStatusWindowKind;
	label: string;
	remainingPercent: number;
	usedPercent: number;
	displayPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
}

export type UsageStatusEvent =
	| {
			v: 1;
			status: "ready";
			providerId: string;
			capturedAt: number;
			displayMode: UsageDisplayMode;
			windows: UsageStatusWindow[];
	  }
	| {
			v: 1;
			status: "unavailable";
	  };

export function unavailableUsageStatusEvent(): UsageStatusEvent {
	return { v: 1, status: "unavailable" };
}

export function buildUsageStatusEvent(
	report: UsageReport,
	model?: UsageModel,
	displayMode: UsageDisplayMode = DEFAULT_USAGE_DISPLAY_MODE,
): UsageStatusEvent {
	const buckets = bucketsForModel(report, model);
	const windows = sortUsageBuckets(buckets).flatMap((bucket) => {
		const remainingPercent = usagePercentRemaining(bucket);
		const usedPercent = usagePercentUsed(bucket);
		const displayPercent = usagePercent(bucket, displayMode);
		if (
			remainingPercent === undefined ||
			usedPercent === undefined ||
			displayPercent === undefined
		) {
			return [];
		}
		return [
			{
				kind: usageWindowKind(bucket),
				label: compactUsageWindowLabel(bucket),
				remainingPercent,
				usedPercent,
				displayPercent,
				...(bucket.windowMinutes === undefined
					? {}
					: { windowMinutes: bucket.windowMinutes }),
				...(bucket.resetsAt === undefined ? {} : { resetsAt: bucket.resetsAt }),
			} satisfies UsageStatusWindow,
		];
	});
	return {
		v: 1,
		status: "ready",
		providerId: report.providerId,
		capturedAt: report.capturedAt,
		displayMode,
		windows,
	};
}

/** Plain fallback for Pi's default footer. Rich rendering belongs to session-ui. */
export function formatUsageStatusline(
	report: UsageReport,
	model?: UsageModel,
	displayMode: UsageDisplayMode = DEFAULT_USAGE_DISPLAY_MODE,
): string | undefined {
	const event = buildUsageStatusEvent(report, model, displayMode);
	if (event.status !== "ready" || event.windows.length === 0) return undefined;
	return event.windows
		.map(
			(window) =>
				`${window.label} ${Math.round(window.displayPercent).toString()}%`,
		)
		.join(" · ");
}

export function usageWindowLabel(bucket: UsageBucket): string {
	const kind = usageWindowKind(bucket);
	if (kind === "weekly") return "1w Window";
	if (kind === "monthly") return "1m Window";
	if (kind === "rolling") return "Rolling Window";
	if (bucket.windowMinutes && bucket.windowMinutes > 0) {
		if (bucket.windowMinutes % 60 === 0) {
			return `${bucket.windowMinutes / 60}h Window`;
		}
		return `${Math.round(bucket.windowMinutes)}m Window`;
	}
	return "Quota";
}

export function compactUsageWindowLabel(bucket: UsageBucket): string {
	const kind = usageWindowKind(bucket);
	if (kind === "weekly") return "1w";
	if (kind === "monthly") return "1m";
	if (kind === "rolling") return "rolling";
	if (bucket.windowMinutes && bucket.windowMinutes > 0) {
		if (bucket.windowMinutes % 60 === 0) return `${bucket.windowMinutes / 60}h`;
		return `${Math.round(bucket.windowMinutes)}m`;
	}
	return "quota";
}

export function usageWindowKind(bucket: UsageBucket): UsageStatusWindowKind {
	const key =
		`${bucket.id} ${bucket.label} ${bucket.period ?? ""}`.toLowerCase();
	if (key.includes("month")) return "monthly";
	if (key.includes("week")) return "weekly";
	if (bucket.windowMinutes === 10_080) return "weekly";
	if (
		bucket.windowMinutes !== undefined &&
		bucket.windowMinutes >= 28 * 24 * 60 &&
		bucket.windowMinutes <= 31 * 24 * 60
	) {
		return "monthly";
	}
	if (bucket.windowMinutes !== undefined && bucket.windowMinutes > 0) {
		return "hourly";
	}
	if (key.includes("rolling")) return "rolling";
	return "quota";
}

/** Canonical status order: hourly/rolling, weekly, monthly, then other quota. */
export function sortUsageBuckets(
	buckets: readonly UsageBucket[],
): UsageBucket[] {
	return [...buckets].sort((left, right) => {
		const rankComparison = usageWindowRank(left) - usageWindowRank(right);
		if (rankComparison !== 0) return rankComparison;
		const durationComparison =
			(left.windowMinutes ?? Number.POSITIVE_INFINITY) -
			(right.windowMinutes ?? Number.POSITIVE_INFINITY);
		if (durationComparison !== 0) return durationComparison;
		return (left.groupId ?? "").localeCompare(right.groupId ?? "");
	});
}

function usageWindowRank(bucket: UsageBucket): number {
	const kind = usageWindowKind(bucket);
	if (kind === "hourly" || kind === "rolling") return 0;
	if (kind === "weekly") return 1;
	if (kind === "monthly") return 2;
	return 3;
}

function bucketsForModel(
	report: UsageReport,
	model?: UsageModel,
): UsageBucket[] {
	const hasGroups = report.buckets.some((bucket) => bucket.groupId);
	const hasModelGroups = report.buckets.some(
		(bucket) => bucket.modelKeys && bucket.modelKeys.length > 0,
	);
	if (!hasGroups || (!report.defaultGroupId && !hasModelGroups)) {
		return report.buckets;
	}
	const group = selectUsageGroup(report, model);
	return report.buckets.filter(
		(bucket) => (bucket.groupId ?? bucket.id) === group,
	);
}

function selectUsageGroup(
	report: UsageReport,
	model?: UsageModel,
): string | undefined {
	const groups = [
		...new Set(report.buckets.map((bucket) => bucket.groupId ?? bucket.id)),
	];
	const keys = [model?.id, model?.name]
		.map(normalizeKey)
		.filter((value): value is string => Boolean(value));
	const specificGroups = groups
		.filter((group) => group !== report.defaultGroupId)
		.sort((left, right) => right.length - left.length);
	for (const group of specificGroups) {
		const bucket = report.buckets.find(
			(candidate) => (candidate.groupId ?? candidate.id) === group,
		);
		const candidates = [group, bucket?.groupLabel, ...(bucket?.modelKeys ?? [])]
			.map(normalizeKey)
			.filter((value): value is string => Boolean(value));
		if (
			candidates.some((candidate) => keys.some((key) => key.includes(candidate)))
		) {
			return group;
		}
	}
	return groups.find((group) => group === report.defaultGroupId) ?? groups[0];
}

function normalizeKey(value: string | undefined): string | undefined {
	return (
		value
			?.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "") || undefined
	);
}
