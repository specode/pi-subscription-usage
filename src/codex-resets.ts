// Adapted from @narumitw/pi-usage@0.53.0 (MIT).
import {
	readStoredCredential,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fingerprintResolvedAuth } from "./core.ts";
import {
	normalizeCodexResetCreditsPayload,
	parseCodexResetOutcome,
	type CodexResetAvailability,
	type CodexResetOption,
	type CodexResetOutcome,
} from "./codex-reset-core.ts";
import {
	adapterForProvider,
	AUTH_FINGERPRINT_SALT,
	fetchProviderJson,
	resolveUsageAuth,
} from "./query.ts";
import type { ResolvedUsageAuth } from "./types.ts";

const RESET_CREDITS_URL =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const RESET_CONSUME_URL = `${RESET_CREDITS_URL}/consume`;

type StoredCredentialReader = (providerId: string) => unknown;

export async function resolveCodexResetAuth(
	ctx: ExtensionContext,
	salt: Uint8Array = AUTH_FINGERPRINT_SALT,
	credentialReader: StoredCredentialReader = readStoredCredential,
): Promise<ResolvedUsageAuth> {
	const model = ctx.model;
	if (model?.provider !== "openai-codex") {
		throw new Error(
			"Codex resets require the current model to use OpenAI Codex.",
		);
	}
	const expectedModel = `${model.provider}/${model.id}`;
	const adapter = adapterForProvider("openai-codex");
	if (!adapter) throw new Error("OpenAI Codex usage support is unavailable.");
	const auth = await resolveUsageAuth(ctx, adapter, salt);
	if (`${ctx.model?.provider}/${ctx.model?.id}` !== expectedModel) {
		throw new Error(
			"The current model changed while resolving Codex reset authentication.",
		);
	}
	if (!auth)
		throw new Error("No runtime credential is configured for OpenAI Codex.");

	const resolvedAccess =
		bearerToken(headerValue(auth.headers, "Authorization")) ?? auth.apiKey;
	if (!resolvedAccess)
		throw new Error("OpenAI Codex OAuth credentials were incomplete.");
	const resolvedAccountId = codexAccountIdFromAccessToken(resolvedAccess);
	if (!resolvedAccountId) {
		throw new Error(
			"The active OpenAI Codex access token did not contain a valid account ID.",
		);
	}
	const credential = asObject(credentialReader("openai-codex"));
	if (credential?.type !== "oauth") {
		throw new Error(
			"Codex resets require the OAuth account configured through Pi /login.",
		);
	}
	const storedAccess = nonemptyString(credential.access);
	const accountId = validHeaderValue(credential.accountId);
	const refresh = nonemptyString(credential.refresh);
	if (
		storedAccess !== resolvedAccess ||
		!accountId ||
		accountId !== resolvedAccountId ||
		!refresh
	) {
		throw new Error(
			"The active Codex runtime account does not match Pi's stored OAuth account.",
		);
	}
	const authorization = `Bearer ${resolvedAccess}`;
	const headers = {
		Authorization: authorization,
		"chatgpt-account-id": accountId,
	};
	return {
		actualProviderId: "openai-codex",
		apiKey: resolvedAccess,
		headers,
		fingerprint: fingerprintResolvedAuth({ headers }, salt),
		secrets: [
			...new Set([
				...auth.secrets,
				storedAccess,
				resolvedAccess,
				authorization,
				accountId,
			]),
		],
		model: auth.model,
	};
}

export async function listCodexResetCredits(
	auth: ResolvedUsageAuth,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<CodexResetAvailability> {
	return normalizeCodexResetCreditsPayload(
		await fetchProviderJson(
			RESET_CREDITS_URL,
			auth,
			signal,
			timeoutMs,
			"Codex reset endpoint",
		),
	);
}

export async function consumeCodexResetCredit(
	auth: ResolvedUsageAuth,
	option: CodexResetOption,
	redeemRequestId: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<CodexResetOutcome> {
	if (!redeemRequestId)
		throw new Error("Codex reset request ID must not be empty.");
	return parseCodexResetOutcome(
		await fetchProviderJson(
			RESET_CONSUME_URL,
			auth,
			signal,
			timeoutMs,
			"Codex reset consume endpoint",
			{
				method: "POST",
				body: {
					redeem_request_id: redeemRequestId,
					...(option.creditId ? { credit_id: option.creditId } : {}),
				},
			},
		),
	);
}

function codexAccountIdFromAccessToken(access: string): string | undefined {
	try {
		const parts = access.split(".");
		if (parts.length !== 3 || !parts[1]) return undefined;
		const payload = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf8"),
		) as unknown;
		const claims = asObject(asObject(payload)?.["https://api.openai.com/auth"]);
		return validHeaderValue(claims?.chatgpt_account_id);
	} catch {
		return undefined;
	}
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonemptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validHeaderValue(value: unknown): string | undefined {
	if (typeof value !== "string" || !value || value.length > 512)
		return undefined;
	return /[^\x20-\x7e]/u.test(value) ? undefined : value;
}

function bearerToken(authorization: string | undefined): string | undefined {
	return /^Bearer\s+(.+)$/iu.exec(authorization ?? "")?.[1];
}

function headerValue(
	headers: Record<string, string>,
	name: string,
): string | undefined {
	return Object.entries(headers).find(
		([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
	)?.[1];
}
