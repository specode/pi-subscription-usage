// Runtime-auth and origin checks adapted from @narumitw/pi-usage@0.53.0 (MIT).
import { randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	errorMessage,
	fingerprintResolvedAuth,
	redactUsageError,
} from "./core.ts";
import { normalizeCodexUsage } from "./providers/codex.ts";
import {
	normalizeGrokBilling,
	normalizeGrokIdentity,
} from "./providers/grok.ts";
import { normalizeKimiUsage } from "./providers/kimi.ts";
import { normalizeOpenCodeGoUsage } from "./providers/opencode-go.ts";
import type {
	ResolvedUsageAuth,
	UsageProviderAdapter,
	UsageReport,
} from "./types.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const GROK_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
const GROK_BILLING_URL =
	"https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const MAX_SUCCESS_BODY_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;

type PiModel = NonNullable<ExtensionContext["model"]>;

export const AUTH_FINGERPRINT_SALT = randomBytes(32);

export const SUPPORTED_ADAPTERS: readonly UsageProviderAdapter[] = [
	{
		id: "openai-codex",
		displayName: "OpenAI Codex",
		providerIds: ["openai-codex"],
		semantics: {
			kind: "consumer-subscription",
			label: "ChatGPT subscription limits",
		},
		async query(auth, signal, timeoutMs) {
			return normalizeCodexUsage(
				await fetchProviderJson(
					CODEX_USAGE_URL,
					auth,
					signal,
					timeoutMs,
					"Codex usage endpoint",
				),
				Date.now(),
			);
		},
	},
	{
		id: "opencode-go",
		displayName: "OpenCode Go",
		providerIds: ["opencode-go"],
		semantics: { kind: "consumer-subscription", label: "OpenCode Go plan usage" },
		async query(auth, signal, timeoutMs) {
			return normalizeOpenCodeGoUsage(
				await fetchProviderJson(
					OPENCODE_GO_USAGE_URL,
					auth,
					signal,
					timeoutMs,
					"OpenCode Go usage endpoint",
				),
				Date.now(),
			);
		},
	},
	{
		id: "kimi-coding",
		displayName: "Kimi Coding",
		providerIds: ["kimi-coding"],
		semantics: { kind: "consumer-subscription", label: "Kimi Coding plan usage" },
		async query(auth, signal, timeoutMs) {
			return normalizeKimiUsage(
				await fetchProviderJson(
					KIMI_USAGE_URL,
					auth,
					signal,
					timeoutMs,
					"Kimi usage endpoint",
				),
				Date.now(),
			);
		},
	},
	{
		id: "xai",
		displayName: "Grok",
		providerIds: ["xai", "xai-auth"],
		semantics: {
			kind: "consumer-subscription",
			label: "SuperGrok subscription usage",
		},
		requiresOAuth: true,
		async query(auth, signal, timeoutMs) {
			const identity = await fetchProviderJson(
				GROK_USER_URL,
				auth,
				signal,
				timeoutMs,
				"Grok identity endpoint",
				{ headers: grokHeaders() },
			);
			const userId = normalizeGrokIdentity(identity);
			const billing = await fetchProviderJson(
				GROK_BILLING_URL,
				auth,
				signal,
				timeoutMs,
				"Grok billing endpoint",
				{ headers: grokHeaders(userId) },
			);
			return normalizeGrokBilling(billing, Date.now());
		},
	},
];

export function adapterForProvider(
	providerId: string | undefined,
): UsageProviderAdapter | undefined {
	return SUPPORTED_ADAPTERS.find((adapter) =>
		providerId ? adapter.providerIds.includes(providerId) : false,
	);
}

export async function resolveUsageAuth(
	ctx: ExtensionContext,
	adapter: UsageProviderAdapter,
	salt: Uint8Array = AUTH_FINGERPRINT_SALT,
): Promise<ResolvedUsageAuth | undefined> {
	const current = ctx.model;
	if (
		current &&
		adapter.providerIds.includes(current.provider) &&
		!hasOfficialOrigin(current.baseUrl, current.provider)
	) {
		throw new Error(
			`${adapter.displayName} usage cannot send a custom provider credential to an official usage endpoint.`,
		);
	}
	const candidates = candidateModels(ctx, adapter.providerIds).filter(
		(candidate) => hasOfficialOrigin(candidate.baseUrl, candidate.provider),
	);
	const currentModel =
		current && adapter.providerIds.includes(current.provider)
			? current
			: undefined;
	const model =
		currentModel ??
		candidates.find(
			(candidate) =>
				!adapter.requiresOAuth || ctx.modelRegistry.isUsingOAuth(candidate),
		);
	if (!model) return undefined;
	if (adapter.requiresOAuth && !ctx.modelRegistry.isUsingOAuth(model)) {
		throw new Error(
			`${adapter.displayName} usage requires Pi OAuth; API-key auth is not accepted.`,
		);
	}
	const result = await ctx.modelRegistry.getProviderAuth(model.provider);
	if (!result) return undefined;
	if (
		result.auth.baseUrl &&
		!hasOfficialOrigin(result.auth.baseUrl, model.provider)
	) {
		throw new Error(
			`${adapter.displayName} usage cannot send a proxy-resolved credential to an official usage endpoint.`,
		);
	}
	const authorization =
		headerValue(result.auth.headers, "Authorization") ??
		(result.auth.apiKey ? `Bearer ${result.auth.apiKey}` : undefined);
	if (!authorization) return undefined;
	const headers = { Authorization: authorization };
	const secrets = [
		result.auth.apiKey,
		headerValue(result.auth.headers, "Authorization"),
		authorization,
	].filter((value): value is string => Boolean(value));
	return {
		actualProviderId: model.provider,
		apiKey: result.auth.apiKey,
		headers,
		fingerprint: fingerprintResolvedAuth({ headers }, salt),
		secrets,
		model,
	};
}

export async function queryProviderUsage(
	adapter: UsageProviderAdapter,
	auth: ResolvedUsageAuth,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<UsageReport> {
	try {
		return await adapter.query(auth, signal, timeoutMs);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw error;
		throw new Error(redactUsageError(errorMessage(error), auth.secrets));
	}
}

export async function fetchProviderJson(
	url: string,
	auth: ResolvedUsageAuth,
	signal: AbortSignal,
	timeoutMs: number,
	description: string,
	request: {
		method?: "GET" | "POST";
		body?: Record<string, unknown>;
		headers?: Record<string, string>;
	} = {},
): Promise<Record<string, unknown>> {
	const controller = new AbortController();
	let timedOut = false;
	const abortFromCaller = () => controller.abort();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", abortFromCaller, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const headers: Record<string, string> = {
			Accept: "application/json",
			"User-Agent": "@specode/pi-subscription-usage/0.1.0",
			...auth.headers,
			...request.headers,
		};
		if (request.body) headers["Content-Type"] = "application/json";
		const response = await fetch(url, {
			method: request.method ?? "GET",
			headers,
			redirect: "error",
			...(request.body ? { body: JSON.stringify(request.body) } : {}),
			signal: controller.signal,
		});
		const text = await readBoundedResponse(
			response,
			response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES,
			!response.ok,
			description,
		);
		if (!response.ok) {
			throw new Error(
				`${description} returned ${response.status} ${response.statusText}: ${redactUsageError(text, auth.secrets)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(
				`${description} returned invalid JSON: ${errorMessage(error)}`,
			);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${description} response was not an object.`);
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		if (timedOut) {
			throw new Error(
				`Timed out after ${Math.round(timeoutMs / 1_000)}s while fetching usage.`,
			);
		}
		if (signal.aborted) {
			throw Object.assign(new Error("Usage query aborted."), {
				name: "AbortError",
			});
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abortFromCaller);
	}
}

async function readBoundedResponse(
	response: Response,
	maxBytes: number,
	truncateOverflow: boolean,
	description: string,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = maxBytes - total;
			if (value.byteLength > remaining) {
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				total = maxBytes;
				truncated = true;
				await reader.cancel();
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	if (truncated && !truncateOverflow) {
		throw new Error(`${description} response exceeded ${maxBytes} bytes.`);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(body);
	return truncated ? `${text}…` : text;
}

function candidateModels(
	ctx: ExtensionContext,
	providerIds: readonly string[],
): PiModel[] {
	const candidates: PiModel[] = [];
	const seen = new Set<string>();
	const add = (model: PiModel | undefined) => {
		if (!model || !providerIds.includes(model.provider)) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(model);
	};
	add(ctx.model);
	for (const model of ctx.modelRegistry.getAvailable()) add(model);
	for (const model of ctx.modelRegistry.getAll()) add(model);
	return candidates;
}

function hasOfficialOrigin(
	value: string | undefined,
	providerId: string,
): boolean {
	if (!value) return false;
	try {
		const origin = new URL(value).origin;
		if (providerId === "openai-codex") return origin === "https://chatgpt.com";
		if (providerId === "opencode-go") return origin === "https://opencode.ai";
		if (providerId === "kimi-coding") return origin === "https://api.kimi.com";
		if (providerId === "xai" || providerId === "xai-auth") {
			return (
				origin === "https://api.x.ai" ||
				origin === "https://cli-chat-proxy.grok.com"
			);
		}
		return false;
	} catch {
		return false;
	}
}

function headerValue(
	headers: Record<string, string | null> | undefined,
	name: string,
): string | undefined {
	return (
		Object.entries(headers ?? {}).find(
			([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
		)?.[1] ?? undefined
	);
}

function grokHeaders(userId?: string): Record<string, string> {
	return {
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-client-version": "0.1.0",
		"x-grok-client-mode":
			process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "headless",
		...(userId ? { "x-userid": userId } : {}),
	};
}
