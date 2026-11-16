// Mistral subscription budget, read from the public billing API Vibe Code uses.
import { sanitizeDisplayText } from "../core.ts";
import type { UsageBucket, UsageMetric, UsageReport } from "../types.ts";

export const MISTRAL_PROVIDER_ID = "mistral";
/** pi-mistral-subscription registered this id before 0.2.0. */
export const MISTRAL_LEGACY_PROVIDER_ID = "mistral-subscription";
export const MISTRAL_OFFICIAL_ORIGINS = ["https://api.mistral.ai"] as const;
export const MISTRAL_SUBSCRIPTION_URL =
	"https://api.mistral.ai/v1/billing/subscription";
export const MISTRAL_BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";

/** The plan's allowance covers a calendar month, shared by Studio, the API and Vibe Code. */
const MONTHLY_WINDOW_MINUTES = 43_200;
const MAX_LABEL_LENGTH = 80;
export const MISTRAL_VIBE_GROUP_ID = "vibe-code";
export const MISTRAL_API_GROUP_ID = "api";

const MISTRAL_PLAN_NAMES: Readonly<Record<string, string>> = {
	INDIVIDUAL: "Individual",
	TEAM: "Team",
	ENTERPRISE: "Enterprise",
};

export function normalizeMistralUsage(
	budgetPayload: unknown,
	capturedAt: number,
	subscriptionPayload?: unknown,
): UsageReport {
	const root = asObject(budgetPayload);
	if (!root) throw new Error("Mistral budget response was not an object.");
	const vibeDetail = asObject(root.vibe_budget);
	const apiDetail = asObject(root.api_budget);
	// Platforms that predate the split serve the Vibe Code budget at the top level.
	const legacyDetail = vibeDetail || apiDetail ? undefined : root;

	const buckets: UsageBucket[] = [];
	const metrics: UsageMetric[] = [];
	const vibe = budgetBucket(
		MISTRAL_VIBE_GROUP_ID,
		"Vibe Code",
		vibeDetail ?? legacyDetail,
	);
	if (vibe) {
		buckets.push(vibe.bucket);
		if (vibe.metric) metrics.push(vibe.metric);
	}
	const api = budgetBucket(MISTRAL_API_GROUP_ID, "API", apiDetail);
	if (api) {
		buckets.push(api.bucket);
		if (api.metric) metrics.push(api.metric);
	}
	if (buckets.length === 0) {
		throw new Error(
			"Mistral budget endpoint returned no displayable allowance.",
		);
	}

	const plan = planName(subscriptionPayload);
	if (plan) metrics.push({ id: "plan", label: "Plan", value: plan });
	const payg = payAsYouGo(subscriptionPayload) ?? payAsYouGo(vibeDetail);
	if (payg !== undefined) {
		metrics.push({
			id: "payg",
			label: "Pay-as-you-go",
			value: payg ? "on" : "off",
		});
	}

	return {
		providerId: MISTRAL_PROVIDER_ID,
		providerName: "Mistral",
		capturedAt,
		source: "mistral-billing",
		semantics: {
			kind: "consumer-subscription",
			label: "Mistral subscription budget",
		},
		// A subscription key spends the Vibe Code allowance; API keys spend the API one.
		defaultGroupId: vibe
			? MISTRAL_VIBE_GROUP_ID
			: api
				? MISTRAL_API_GROUP_ID
				: undefined,
		buckets,
		metrics,
	};
}

function budgetBucket(
	groupId: string,
	groupLabel: string,
	detail: Record<string, unknown> | undefined,
): { bucket: UsageBucket; metric?: UsageMetric } | undefined {
	if (!detail) return undefined;
	const usedPercent = asPercent(detail.usage_percentage);
	const limit = asPositiveNumber(detail.initial_budget);
	if (usedPercent === undefined || limit === undefined) return undefined;
	const resetsAt = parseDate(detail.reset_at);
	const window = {
		period: "monthly",
		windowMinutes: MONTHLY_WINDOW_MINUTES,
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
	const id = `${groupId}:budget`;
	const label = `${groupLabel} budget`;
	const currency = asCurrency(detail.currency);
	if (currency !== undefined && currency !== "USD") {
		// Keep the percentage exact and show the allowance in its own currency.
		return {
			bucket: {
				id,
				label,
				groupId,
				groupLabel,
				used: usedPercent,
				remaining: clampPercent(100 - usedPercent),
				limit: 100,
				unit: "percent",
				...window,
			},
			metric: {
				id: `${groupId}-allowance`,
				label: `${groupLabel} allowance`,
				value: `${formatAmount(limit)} ${currency}`,
			},
		};
	}
	const used = roundMoney((limit * usedPercent) / 100);
	return {
		bucket: {
			id,
			label,
			groupId,
			groupLabel,
			used,
			remaining: roundMoney(limit - used),
			limit,
			unit: "usd",
			...window,
		},
	};
}

function planName(payload: unknown): string | undefined {
	const name = asObject(payload)?.plan_name;
	if (typeof name !== "string") return undefined;
	const plan = sanitizeDisplayText(name, MAX_LABEL_LENGTH);
	if (!plan) return undefined;
	return Object.hasOwn(MISTRAL_PLAN_NAMES, plan)
		? MISTRAL_PLAN_NAMES[plan]
		: plan;
}

function payAsYouGo(payload: unknown): boolean | undefined {
	const value = asObject(payload)?.payg_enabled;
	return typeof value === "boolean" ? value : undefined;
}

function asCurrency(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const currency = value.trim().toUpperCase();
	return /^[A-Z]{3}$/u.test(currency) ? currency : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
	const parsed = asFiniteNumber(value);
	return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

/** The endpoint reports a percentage already, not a fraction. */
function asPercent(value: unknown): number | undefined {
	const parsed = asFiniteNumber(value);
	return parsed === undefined ? undefined : clampPercent(parsed);
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	if (typeof value === "string" && !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDate(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1_000);
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function roundMoney(value: number): number {
	return Math.round(value * 100) / 100;
}

function formatAmount(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
