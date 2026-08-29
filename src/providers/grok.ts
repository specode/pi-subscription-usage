// Adapted from pi-grok-usage@1.0.4 (MIT).
import { sanitizeDisplayText } from "../core.ts";
import type { UsageBucket, UsageMetric, UsageReport } from "../types.ts";

const MAX_USER_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 80;
const MAX_CENTS = 1_000_000_000_000;
const USER_ID_PATTERN = /^[\x21-\x7e]+$/u;
const WEEKLY_WINDOW_MINUTES = 10_080;
const MONTHLY_WINDOW_MINUTES = 43_200;
// Grok CLI proxy protocol version; independent of this extension's package version.
const GROK_CLIENT_VERSION = "0.1.0";

export function grokRequestHeaders(userId?: string): Record<string, string> {
	return {
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-client-version": GROK_CLIENT_VERSION,
		"x-grok-client-mode":
			process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "headless",
		...(userId ? { "x-userid": userId } : {}),
	};
}

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

/** Unified SuperGrok accounts may expose their quota only on monthly billing. */
export function shouldProbeGrokMonthly(creditsPayload: unknown): boolean {
	const config = billingConfig(creditsPayload);
	if (!config) return true;
	return (
		config.isUnifiedBillingUser === true ||
		parseCreditsWindow(config) === undefined
	);
}

/** A failed monthly request is fatal when credits contain no reliable quota. */
export function requiresGrokMonthlyQuota(creditsPayload: unknown): boolean {
	return parseCreditsWindow(billingConfig(creditsPayload)) === undefined;
}

export function normalizeGrokBilling(
	creditsPayload: unknown,
	capturedAt: number,
	monthlyPayload?: unknown | null,
): UsageReport {
	const creditsRoot = asObject(creditsPayload);
	if (!creditsRoot) throw new Error("Grok billing response was not an object.");
	const creditsConfig = billingConfig(creditsPayload);
	const weekly = parseCreditsWindow(creditsConfig);

	const monthlyRoot = readOptionalPayload(
		monthlyPayload,
		"Grok monthly billing response was not an object.",
	);
	let monthlyConfig: Record<string, unknown> | undefined;
	if (monthlyRoot !== undefined) {
		monthlyConfig = billingConfig(monthlyRoot, "skip");
	} else if (monthlyPayload === undefined && !weekly) {
		monthlyConfig = creditsConfig;
	}
	const monthly = parseMonthlyWindow(monthlyConfig);

	const buckets: UsageBucket[] = [];
	if (weekly) buckets.push(weekly);
	if (monthly) buckets.push(monthly);
	if (buckets.length === 0) {
		throw new Error(
			"Grok billing endpoint returned no displayable quota window.",
		);
	}

	const primaryMetrics = collectMetrics(creditsConfig);
	addAccountMetrics(primaryMetrics, creditsRoot);
	const extraMetrics =
		monthlyConfig && monthlyConfig !== creditsConfig
			? collectMetrics(monthlyConfig)
			: [];
	if (monthlyRoot) addAccountMetrics(extraMetrics, monthlyRoot);
	const metrics = mergeMetrics(primaryMetrics, extraMetrics);

	return {
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
}

function readOptionalPayload(
	payload: unknown | null | undefined,
	invalidMessage: string,
): Record<string, unknown> | undefined {
	if (payload === undefined || payload === null) return undefined;
	const root = asObject(payload);
	if (!root) throw new Error(invalidMessage);
	return root;
}

function billingConfig(
	payload: unknown,
	invalidConfig: "throw" | "skip" = "throw",
): Record<string, unknown> | undefined {
	const root = asObject(payload);
	if (!root) return undefined;
	if (root.config === undefined) return undefined;
	const config = asObject(root.config);
	if (!config) {
		if (invalidConfig === "skip") return undefined;
		throw new Error("Grok billing response contained an invalid config object.");
	}
	return config;
}

function parseCreditsWindow(
	config: Record<string, unknown> | undefined,
): UsageBucket | undefined {
	if (!config) return undefined;
	const period = asObject(config.currentPeriod);
	let used = boundedPercent(config.creditUsagePercent);
	if (used === undefined && isWeeklyPeriod(period)) {
		const usedCents = boundedCents(config.used);
		const limitCents = boundedCents(config.monthlyLimit);
		if (usedCents !== undefined && limitCents !== undefined && limitCents > 0) {
			used = Math.min(100, (usedCents / limitCents) * 100);
		}
	}
	if (used === undefined) return undefined;
	return percentWindow("weekly", used, config, period, WEEKLY_WINDOW_MINUTES);
}

function parseMonthlyWindow(
	config: Record<string, unknown> | undefined,
): UsageBucket | undefined {
	if (!config) return undefined;
	const usedCents = boundedCents(config.used);
	const limitCents = boundedCents(config.monthlyLimit);
	if (usedCents === undefined || limitCents === undefined || limitCents <= 0) {
		return undefined;
	}
	const used = Math.min(100, (usedCents / limitCents) * 100);
	const period = asObject(config.currentPeriod);
	return percentWindow(
		"monthly",
		used,
		config,
		isWeeklyPeriod(period) ? undefined : period,
		MONTHLY_WINDOW_MINUTES,
	);
}

function percentWindow(
	kind: "weekly" | "monthly",
	used: number,
	config: Record<string, unknown>,
	period: Record<string, unknown> | undefined,
	fallbackMinutes: number,
): UsageBucket {
	const periodInfo = parseUsagePeriod(config, period);
	const bucket: UsageBucket = {
		id: kind,
		label: kind === "monthly" ? "Monthly window" : "Weekly window",
		used,
		remaining: 100 - used,
		limit: 100,
		unit: "percent",
		period: kind,
		windowMinutes:
			periodInfo.period === kind
				? (periodInfo.windowMinutes ?? fallbackMinutes)
				: fallbackMinutes,
	};
	const resetsAt = parseTimestamp(
		kind === "monthly"
			? (config.billingPeriodEnd ?? period?.end)
			: (period?.end ?? config.billingPeriodEnd),
	);
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
			return { period: "weekly", windowMinutes: WEEKLY_WINDOW_MINUTES };
		}
		if (type.toUpperCase().includes("MONTHLY")) {
			return { period: "monthly", windowMinutes: MONTHLY_WINDOW_MINUTES };
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

function isWeeklyPeriod(
	period: Record<string, unknown> | undefined,
): period is Record<string, unknown> {
	return (
		typeof period?.type === "string" && period.type.toUpperCase().includes("WEEK")
	);
}

function collectMetrics(
	config: Record<string, unknown> | undefined,
): UsageMetric[] {
	const metrics: UsageMetric[] = [];
	addUsdMetric(
		metrics,
		"included-used",
		"Included Used",
		boundedCents(config?.used),
	);
	addUsdMetric(
		metrics,
		"included-limit",
		"Included Total",
		boundedCents(config?.monthlyLimit),
	);
	addUsdMetric(
		metrics,
		"on-demand-used",
		"On-Demand Used",
		boundedCents(config?.onDemandUsed),
	);
	addUsdMetric(
		metrics,
		"on-demand-cap",
		"On-Demand Cap",
		boundedCents(config?.onDemandCap),
	);
	addUsdMetric(
		metrics,
		"prepaid-balance",
		"Prepaid Balance",
		boundedCents(config?.prepaidBalance),
	);
	return metrics;
}

function addAccountMetrics(
	metrics: UsageMetric[],
	root: Record<string, unknown>,
): void {
	const tier = boundedLabel(root.subscriptionTier);
	if (tier) metrics.push({ id: "plan", label: "Plan", value: tier });
	if (typeof root.onDemandEnabled === "boolean") {
		metrics.push({
			id: "on-demand",
			label: "On-Demand",
			value: root.onDemandEnabled ? "on" : "off",
		});
	}
}

function mergeMetrics(
	primary: UsageMetric[],
	extra: UsageMetric[],
): UsageMetric[] {
	const seen = new Set(primary.map((metric) => metric.id));
	return [
		...primary,
		...extra.filter((metric) => {
			if (seen.has(metric.id)) return false;
			seen.add(metric.id);
			return true;
		}),
	];
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
