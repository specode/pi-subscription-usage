import { sanitizeDisplayText } from "../core.ts";
import type { UsageBucket, UsageReport } from "../types.ts";

export const OPENAI_PROVIDER_ID = "openai";

/** Decode only routing metadata from Pi's active OAuth credential, not identity claims. */
export function openaiClientIdFromAuthorization(authorization: string): string {
	try {
		const token = /^Bearer\s+(\S+)$/iu.exec(authorization)?.[1];
		const parts = token?.split(".");
		if (parts?.length !== 3) throw new Error();
		const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		if (
			claims.iss !== "https://auth.openai.com" ||
			claims.aud !== "https://api.openai.com/v1" ||
			typeof claims.scope !== "string" ||
			!claims.scope.split(/\s+/u).includes("chatgpt.tokens.use.direct") ||
			typeof claims.client_id !== "string" ||
			!/^oaiapp_[a-zA-Z0-9_-]+$/u.test(claims.client_id)
		) throw new Error();
		return claims.client_id;
	} catch {
		throw new Error("OpenAI usage requires a Sign in with ChatGPT OAuth credential with an application ID.");
	}
}

/**
 * The ChatGPT usage page reads app-scoped subscription windows here, separately
 * from Codex's rate_limit. Match the active registration, never an app name or
 * the first result: a different Codex account must not supply another quota.
 */
export function normalizeOpenAIUsage(
	payload: unknown,
	clientId: string,
	capturedAt: number,
): UsageReport {
	const root = asObject(payload);
	const matches = Array.isArray(root?.items)
		? root.items.map(asObject).filter((item) => item?.id === clientId)
		: [];
	if (!clientId || matches.length !== 1) {
		throw new Error("The active OpenAI application was not uniquely found in this Codex account. Sign in to OpenAI and OpenAI Codex with the same ChatGPT account/workspace.");
	}
	const app = matches[0]!;
	const windows = Array.isArray(app.windows) ? app.windows : [];
	const buckets: UsageBucket[] = windows.map((raw, index) => {
		const window = asObject(raw);
		const used = number(window?.used_percent);
		const remaining = number(window?.remaining_percent);
		const seconds = number(window?.limit_window_seconds);
		const reset = number(window?.reset_at);
		if (
			used === undefined || used < 0 || used > 100 ||
			seconds === undefined || seconds <= 0 ||
			(remaining !== undefined && (remaining < 0 || remaining > 100))
		) throw new Error("OpenAI subscription returned an invalid usage window.");
		return {
			id: `chatpass:${index}`,
			label: "App subscription limit",
			used,
			remaining: remaining ?? 100 - used,
			limit: 100,
			unit: "percent",
			windowMinutes: Math.ceil(seconds / 60),
			...(reset !== undefined && reset > 0 ? { resetsAt: reset } : {}),
		};
	});
	if (buckets.length === 0) {
		throw new Error("OpenAI subscription returned no displayable app usage windows.");
	}
	const name = typeof app.name === "string" ? sanitizeDisplayText(app.name, 80) : "";
	const allowance = number(app.allowed_usage_percent);
	return {
		providerId: OPENAI_PROVIDER_ID,
		providerName: "OpenAI (ChatGPT subscription)",
		capturedAt,
		source: "openai-chatpass-pi-auth",
		semantics: { kind: "consumer-subscription", label: "ChatGPT app subscription limits" },
		buckets,
		metrics: [
			{ id: "source", label: "Source", value: "Matched app in Pi Codex account" },
			...(name ? [{ id: "app", label: "App", value: name }] : []),
			...(allowance !== undefined && allowance >= 0 && allowance <= 100
				? [{ id: "allowance", label: "Plan Allowance", value: `${allowance}%` }]
				: []),
		],
	};
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
