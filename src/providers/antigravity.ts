import { sanitizeDisplayText } from "../core.ts";
import type { UsageBucket, UsageMetric, UsageReport } from "../types.ts";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_OFFICIAL_ORIGINS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
] as const;

export const ANTIGRAVITY_DEFAULT_GROUP_ID = "gemini-models";
export const ANTIGRAVITY_3P_GROUP_ID = "claude-and-gpt-models";
export const ANTIGRAVITY_ARGON_GROUP_ID = "gemini-argon";

export const ANTIGRAVITY_USER_AGENT =
	process.env.ANTIGRAVITY_USER_AGENT ||
	"antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

export const ANTIGRAVITY_LOAD_CODE_ASSIST_BODY = {
	metadata: {
		ideType: "ANTIGRAVITY",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI",
	},
} as const;

export function antigravityRequestHeaders(): Record<string, string> {
	return {
		"User-Agent": ANTIGRAVITY_USER_AGENT,
	};
}

const ANTIGRAVITY_RETRYABLE_STATUSES = new Set([
	403, 404, 429, 500, 502, 503, 504,
]);

export function antigravityQueryOrigins(baseUrl: string | undefined): string[] {
	const origins: string[] = [];
	const add = (origin: string) => {
		if (
			ANTIGRAVITY_OFFICIAL_ORIGINS.includes(
				origin as (typeof ANTIGRAVITY_OFFICIAL_ORIGINS)[number],
			) &&
			!origins.includes(origin)
		) {
			origins.push(origin);
		}
	};
	if (baseUrl) {
		try {
			add(new URL(baseUrl).origin);
		} catch {
			// A malformed model URL falls through to the official list.
		}
	}
	for (const origin of ANTIGRAVITY_OFFICIAL_ORIGINS) add(origin);
	return origins;
}

export function isRetryableAntigravityError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	const status = Number(/ returned (\d{3})\b/u.exec(message)?.[1]);
	return ANTIGRAVITY_RETRYABLE_STATUSES.has(status);
}

export function extractAntigravityAuth(
	apiKey: string | undefined,
	existingAuthHeader: string | undefined,
): { authorization?: string; token?: string; email?: string } {
	const fromKey = apiKey ? parseCredentialMaterial(apiKey) : undefined;
	const fromHeader =
		!fromKey?.token && existingAuthHeader
			? parseBearerCredential(existingAuthHeader)
			: undefined;
	const token = fromKey?.token ?? fromHeader?.token;
	const email = fromKey?.email ?? fromHeader?.email;
	if (!token) {
		if (fromKey?.json || fromHeader?.json) return { email };
		return { authorization: existingAuthHeader, email };
	}
	return { authorization: `Bearer ${token}`, token, email };
}

export function emailFromAntigravityCredential(
	credential: unknown,
): string | undefined {
	const record = asObject(credential);
	if (record?.type !== "oauth") return undefined;
	return asEmail(record.email);
}

export function normalizeAntigravityUsage(
	payload: unknown,
	capturedAt: number,
	planPayload?: unknown,
	accountEmail?: string,
): UsageReport {
	const root = asObject(payload);
	if (!root || !Array.isArray(root.groups)) {
		throw new Error("Antigravity usage response was not an object.");
	}

	const buckets: UsageBucket[] = [];
	for (const rawGroup of root.groups) {
		const group = asObject(rawGroup);
		if (!group) continue;
		const classification = classifyGroup(group);
		const rawBuckets = Array.isArray(group.buckets) ? group.buckets : [];
		for (const rawBucket of rawBuckets) {
			const b = asObject(rawBucket);
			if (!b) continue;
			const remainingFraction = asNumber(b.remainingFraction);
			if (remainingFraction === undefined) continue;

			const clampedFraction = Math.min(1, Math.max(0, remainingFraction));
			const remaining = clampPercent(roundPercent(clampedFraction * 100));
			const used = clampPercent(roundPercent(100 - remaining));

			const bucketId =
				asString(b.bucketId) || asString(b.displayName) || "bucket";
			const windowMinutes = parseWindowMinutes(b.window, bucketId);
			const resetsAt = asEpochSeconds(b.resetTime);
			const label = asString(b.displayName) || "Limit";

			buckets.push({
				id: `${classification.groupId}:${bucketId}`,
				label,
				groupId: classification.groupId,
				groupLabel: classification.groupLabel,
				modelKeys: classification.modelKeys,
				used,
				remaining,
				limit: 100,
				unit: "percent",
				...(windowMinutes !== undefined ? { windowMinutes } : {}),
				...(resetsAt !== undefined ? { resetsAt } : {}),
			});
		}
	}

	if (buckets.length === 0) {
		throw new Error(
			"Antigravity usage endpoint returned no displayable usage data.",
		);
	}

	const metrics: UsageMetric[] = [];
	const email = asEmail(accountEmail);
	if (email) {
		metrics.push({ id: "email", label: "Email", value: email });
	}

	const plan = extractPlanName(planPayload);
	if (plan) {
		metrics.push({ id: "plan", label: "Plan", value: plan });
	}

	const project = extractProject(planPayload);
	if (project) {
		metrics.push({ id: "project", label: "Project", value: project });
	}

	const defaultGroupId = buckets.some(
		(b) => b.groupId === ANTIGRAVITY_DEFAULT_GROUP_ID,
	)
		? ANTIGRAVITY_DEFAULT_GROUP_ID
		: buckets[0]?.groupId;

	return {
		providerId: ANTIGRAVITY_PROVIDER_ID,
		providerName: "Antigravity",
		capturedAt,
		source: "antigravity-quota",
		semantics: {
			kind: "consumer-subscription",
			label: "Antigravity subscription limits",
		},
		defaultGroupId,
		buckets,
		metrics,
	};
}

function classifyGroup(group: Record<string, unknown>): {
	groupId: string;
	groupLabel: string;
	modelKeys: string[];
} {
	const displayName = asString(group.displayName) ?? "";
	const rawBuckets = Array.isArray(group.buckets) ? group.buckets : [];
	const bucketIds = rawBuckets
		.map((b) => asString(asObject(b)?.bucketId)?.toLowerCase() ?? "")
		.filter(Boolean);

	if (bucketIds.some((id) => id.includes("argon"))) {
		return {
			groupId: ANTIGRAVITY_ARGON_GROUP_ID,
			groupLabel: displayName || "Gemini 4 Argon",
			modelKeys: ["argon", "gemini-4-argon"],
		};
	}

	if (
		bucketIds.some(
			(id) => id.startsWith("3p") || id.includes("claude") || id.includes("gpt"),
		)
	) {
		return {
			groupId: ANTIGRAVITY_3P_GROUP_ID,
			groupLabel: displayName || "Claude and GPT models",
			modelKeys: ["claude", "gpt-oss"],
		};
	}

	if (bucketIds.some((id) => id.includes("gemini"))) {
		return {
			groupId: ANTIGRAVITY_DEFAULT_GROUP_ID,
			groupLabel: displayName || "Gemini Models",
			modelKeys: ["gemini-flash", "gemini-pro", "gemini"],
		};
	}

	const fallbackSlug =
		displayName
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "") || "other";

	return {
		groupId: fallbackSlug,
		groupLabel: displayName || "Other Models",
		modelKeys: [fallbackSlug],
	};
}

function parseWindowMinutes(
	windowValue: unknown,
	bucketId: string,
): number | undefined {
	const str = asString(windowValue)?.toLowerCase();
	if (str === "weekly" || str === "1w" || str === "week") return 10_080;
	if (str === "monthly" || str === "1m" || str === "month") return 43_200;
	if (str === "5h") return 300;
	if (str) {
		const hourMatch = /^(\d+)\s*h$/iu.exec(str);
		if (hourMatch) return Number.parseInt(hourMatch[1], 10) * 60;
		const dayMatch = /^(\d+)\s*d$/iu.exec(str);
		if (dayMatch) return Number.parseInt(dayMatch[1], 10) * 1_440;
		const minMatch = /^(\d+)\s*m$/iu.exec(str);
		if (minMatch) return Number.parseInt(minMatch[1], 10);
	}
	const id = bucketId.toLowerCase();
	if (id.includes("5h")) return 300;
	if (id.includes("weekly") || id.includes("1w")) return 10_080;
	if (id.includes("monthly") || id.includes("1m")) return 43_200;
	return undefined;
}

function extractPlanName(planPayload: unknown): string | undefined {
	const root = asObject(planPayload);
	if (!root) return undefined;
	const paidTier = asObject(root.paidTier);
	const paidName = asString(paidTier?.name);
	if (paidName) return paidName;
	const currentTier = asObject(root.currentTier);
	const currentName = asString(currentTier?.name);
	if (currentName) return currentName;
	return undefined;
}

function extractProject(planPayload: unknown): string | undefined {
	const root = asObject(planPayload);
	if (!root) return undefined;
	return asString(root.cloudaicompanionProject);
}

function parseCredentialMaterial(value: string): {
	token?: string;
	email?: string;
	json: boolean;
} {
	const trimmed = value.trim();
	const json = trimmed.startsWith("{") && trimmed.endsWith("}");
	if (!json) return { token: trimmed || undefined, json: false };
	try {
		const parsed = JSON.parse(trimmed) as {
			token?: unknown;
			access?: unknown;
			email?: unknown;
		};
		const token =
			typeof parsed.token === "string" && parsed.token.trim()
				? parsed.token.trim()
				: typeof parsed.access === "string" && parsed.access.trim()
					? parsed.access.trim()
					: undefined;
		const email =
			typeof parsed.email === "string" && parsed.email.trim()
				? parsed.email.trim()
				: undefined;
		return { token, email, json: true };
	} catch {
		return { json: true };
	}
}

function parseBearerCredential(header: string): {
	token?: string;
	email?: string;
	json: boolean;
} | undefined {
	const match = /^Bearer\s+(\S.*)$/iu.exec(header.trim());
	return match ? parseCredentialMaterial(match[1]) : undefined;
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

function asEmail(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 254) return undefined;
	const email = sanitizeDisplayText(value, 254).toLowerCase();
	return /^[^\s@]+@[^\s@]+$/u.test(email) ? email : undefined;
}

function asEpochSeconds(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function roundPercent(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}
