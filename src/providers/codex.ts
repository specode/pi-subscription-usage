// Adapted from @narumitw/pi-usage@0.53.0 (MIT).
import { sanitizeDisplayText } from "../core.ts";
import type { UsageBucket, UsageMetric, UsageReport } from "../types.ts";

export function normalizeCodexUsage(
	payload: unknown,
	capturedAt: number,
): UsageReport {
	const root = asObject(payload);
	if (!root) throw new Error("Codex usage response was not an object.");
	const buckets: UsageBucket[] = [];
	normalizeRateLimitGroup(buckets, "codex", "Codex", root.rate_limit, false);
	const additional = Array.isArray(root.additional_rate_limits)
		? root.additional_rate_limits
		: [];
	for (const item of additional) {
		const value = asObject(item);
		const id = asString(value?.metered_feature) ?? asString(value?.limit_name);
		if (!value || !id) continue;
		try {
			normalizeRateLimitGroup(
				buckets,
				id,
				asString(value.limit_name) ?? id,
				value.rate_limit,
				true,
			);
		} catch {
			// Optional model-specific buckets must not hide primary usage.
		}
	}

	const metrics: UsageMetric[] = [];
	const credits = asObject(root.credits);
	if (credits?.has_credits === true) {
		if (credits.unlimited === true) {
			metrics.push({ id: "credits", label: "Credits", value: "unlimited" });
		} else {
			const balance = asNumber(credits.balance);
			metrics.push({
				id: "credits",
				label: "Credits",
				value: balance ?? "available",
				...(balance === undefined ? {} : { unit: "count" as const }),
			});
		}
	} else if (credits?.has_credits === false) {
		metrics.push({ id: "credits", label: "Credits", value: "none" });
	}
	const resetCredits = asObject(root.rate_limit_reset_credits);
	const resetCount = asNonnegativeInteger(resetCredits?.available_count);
	if (resetCount !== undefined) {
		metrics.push({
			id: "reset-credits",
			label: "Usage limit resets",
			value: resetCount,
			unit: "count",
		});
	}
	if (buckets.length === 0 && metrics.length === 0) {
		throw new Error("Codex usage endpoint returned no displayable usage data.");
	}
	const planType = asString(root.plan_type);
	return {
		providerId: "openai-codex",
		providerName: "OpenAI Codex",
		capturedAt,
		source: "codex-pi-auth",
		semantics: {
			kind: "consumer-subscription",
			label: "ChatGPT subscription limits",
		},
		buckets,
		metrics,
		...(planType ? { notes: [`Plan: ${planType}`] } : {}),
	};
}

function normalizeRateLimitGroup(
	buckets: UsageBucket[],
	groupId: string,
	groupLabel: string,
	raw: unknown,
	optional: boolean,
): void {
	if (raw === undefined || raw === null) return;
	const details = asObject(raw);
	if (!details) {
		if (optional) return;
		throw new Error("Codex rate limit was not an object.");
	}
	addWindow(buckets, groupId, groupLabel, "primary", details.primary_window);
	addWindow(buckets, groupId, groupLabel, "secondary", details.secondary_window);
}

function addWindow(
	buckets: UsageBucket[],
	groupId: string,
	groupLabel: string,
	position: "primary" | "secondary",
	raw: unknown,
): void {
	if (raw === undefined || raw === null) return;
	const value = asObject(raw);
	if (!value) throw new Error("Codex rate-limit window was not an object.");
	const used = asNumber(value.used_percent);
	if (used === undefined) return;
	const seconds = asNumber(value.limit_window_seconds);
	const resetsAt = asNumber(value.reset_at);
	buckets.push({
		id: `${groupId}:${position}`,
		label: position === "primary" ? "Primary limit" : "Secondary limit",
		groupId,
		groupLabel,
		modelKeys: [groupId, groupLabel],
		used,
		remaining: 100 - clampPercent(used),
		limit: 100,
		unit: "percent",
		...(seconds !== undefined && seconds > 0
			? { windowMinutes: Math.ceil(seconds / 60) }
			: {}),
		...(resetsAt === undefined ? {} : { resetsAt }),
	});
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string"
		? sanitizeDisplayText(value, 160) || undefined
		: undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function asNonnegativeInteger(value: unknown): number | undefined {
	const parsed = asNumber(value);
	return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0
		? parsed
		: undefined;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}
