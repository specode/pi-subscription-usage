// Adapted from pi-grok-usage@1.0.4 (MIT).
import { sanitizeDisplayText } from "../core.ts";
import type { UsageBucket, UsageMetric, UsageReport } from "../types.ts";

const MAX_USER_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 80;
const MAX_CENTS = 1_000_000_000_000;
const USER_ID_PATTERN = /^[\x21-\x7e]+$/u;

export function normalizeGrokIdentity(payload: unknown): string {
	const userId = asObject(payload)?.userId;
	if (
		typeof userId !== "string" ||
		!userId ||
		userId.length > MAX_USER_ID_LENGTH ||
		!USER_ID_PATTERN.test(userId)
	) {
		throw new Error(
			"xAI account identity could not be verified; billing was not requested.",
		);
	}
	return userId;
}

export function normalizeGrokBilling(
	payload: unknown,
	capturedAt: number,
): UsageReport {
	const root = asObject(payload);
	if (!root) throw new Error("Grok billing response was not an object.");
	const config = root.config === undefined ? undefined : asObject(root.config);
	if (root.config !== undefined && !config) {
		throw new Error("Grok billing response contained an invalid config object.");
	}
	const included = createIncludedBucket(config);
	const buckets = included ? [included] : [];
	const metrics = collectMetrics(config);
	if (buckets.length === 0 && metrics.length === 0) {
		throw new Error("Grok billing endpoint returned no displayable usage data.");
	}
	const notes = collectNotes(root);
	const report: UsageReport = {
		providerId: "xai",
		providerName: "Grok",
		capturedAt,
		source: "grok-cli-billing",
		semantics: {
			kind: "consumer-subscription",
			label: "SuperGrok subscription usage",
		},
		buckets,
		metrics,
	};
	if (notes.length > 0) report.notes = notes;
	return report;
}

function createIncludedBucket(
	config: Record<string, unknown> | undefined,
): UsageBucket | undefined {
	const percent = boundedPercent(config?.creditUsagePercent);
	const usedCents = boundedCents(config?.used);
	const limitCents = boundedCents(config?.monthlyLimit);
	let used = percent;
	if (
		used === undefined &&
		usedCents !== undefined &&
		limitCents !== undefined &&
		limitCents > 0
	) {
		used = Math.min(100, (usedCents / limitCents) * 100);
	}
	if (used === undefined) return undefined;
	const period = asObject(config?.currentPeriod);
	const resetsAt = parseTimestamp(period?.end ?? config?.billingPeriodEnd);
	const periodInfo = parseUsagePeriod(config, period);
	const bucket: UsageBucket = {
		id: "included",
		label: "Included usage",
		used,
		remaining: 100 - used,
		limit: 100,
		unit: "percent",
		...periodInfo,
	};
	if (resetsAt !== undefined) bucket.resetsAt = resetsAt;
	return bucket;
}

function parseUsagePeriod(
	config: Record<string, unknown> | undefined,
	currentPeriod: Record<string, unknown> | undefined,
): Pick<UsageBucket, "period" | "windowMinutes"> {
	const type = currentPeriod?.type;
	if (typeof type === "string") {
		if (type.toUpperCase().includes("WEEKLY")) {
			return { period: "weekly", windowMinutes: 10_080 };
		}
		if (type.toUpperCase().includes("MONTHLY")) {
			return { period: "monthly", windowMinutes: 43_200 };
		}
	}
	const start = parseTimestamp(
		currentPeriod?.start ?? config?.billingPeriodStart,
	);
	const end = parseTimestamp(currentPeriod?.end ?? config?.billingPeriodEnd);
	if (start === undefined || end === undefined || end <= start) return {};
	const windowMinutes = Math.round((end - start) / 60);
	if (windowMinutes >= 6 * 24 * 60 && windowMinutes <= 8 * 24 * 60) {
		return { period: "weekly", windowMinutes };
	}
	if (windowMinutes >= 28 * 24 * 60 && windowMinutes <= 31 * 24 * 60) {
		return { period: "monthly", windowMinutes };
	}
	return { windowMinutes };
}

function collectMetrics(
	config: Record<string, unknown> | undefined,
): UsageMetric[] {
	const metrics: UsageMetric[] = [];
	addUsdMetric(
		metrics,
		"included-used",
		"Included credits used",
		boundedCents(config?.used),
	);
	addUsdMetric(
		metrics,
		"included-limit",
		"Included credits limit",
		boundedCents(config?.monthlyLimit),
	);
	addUsdMetric(
		metrics,
		"on-demand-used",
		"On-demand credits used",
		boundedCents(config?.onDemandUsed),
	);
	addUsdMetric(
		metrics,
		"on-demand-cap",
		"On-demand credits cap",
		boundedCents(config?.onDemandCap),
	);
	addUsdMetric(
		metrics,
		"prepaid-balance",
		"Prepaid balance",
		boundedCents(config?.prepaidBalance),
	);
	return metrics;
}

function collectNotes(root: Record<string, unknown>): string[] {
	const notes: string[] = [];
	const tier = boundedLabel(root.subscriptionTier);
	if (tier) notes.push(`Plan: ${tier}`);
	if (typeof root.onDemandEnabled === "boolean") {
		notes.push(
			`On-demand billing: ${root.onDemandEnabled ? "enabled" : "disabled"}`,
		);
	}
	return notes;
}

function addUsdMetric(
	metrics: UsageMetric[],
	id: string,
	label: string,
	cents: number | undefined,
): void {
	if (cents === undefined) return;
	metrics.push({ id, label, value: cents / 100, unit: "usd" });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function boundedLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const label = sanitizeDisplayText(value, MAX_LABEL_LENGTH);
	return label || undefined;
}

function boundedPercent(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 100
		? value
		: undefined;
}

function boundedCents(value: unknown): number | undefined {
	const wrapper = asObject(value);
	const raw = wrapper ? wrapper.val : value;
	return typeof raw === "number" &&
		Number.isSafeInteger(raw) &&
		raw >= 0 &&
		raw <= MAX_CENTS
		? raw
		: undefined;
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string" || value.length > 64) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}
