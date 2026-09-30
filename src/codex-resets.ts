// Adapted from @narumitw/pi-usage@0.53.0 (MIT).
import {
	readStoredCredential,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fingerprintResolvedAuth } from "./core.ts";
import {
	normalizeCodexResetCreditsPayload,
	parseCodexResetOutcome,
	verifyCodexStoredOAuthCredential,
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
import { CODEX_PROVIDER_ID } from "./providers/codex-constants.ts";
import { OPENAI_PROVIDER_ID } from "./providers/openai.ts";

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
	if (model?.provider !== CODEX_PROVIDER_ID && model?.provider !== OPENAI_PROVIDER_ID) {
		throw new Error(
			"Account resets require the current model to use OpenAI or OpenAI Codex.",
		);
	}
	const expectedModel = `${model.provider}/${model.id}`;
	const adapter = adapterForProvider(model.provider);
	if (!adapter) throw new Error(`Usage support for ${model.provider} is unavailable.`);
	const auth = await resolveUsageAuth(ctx, adapter, salt);
	if (`${ctx.model?.provider}/${ctx.model?.id}` !== expectedModel) {
		throw new Error(
			"The current model changed while resolving reset authentication.",
		);
	}
	if (!auth)
		throw new Error(`No runtime credential is configured for ${adapter.displayName}.`);

	const resolvedAccess =
		bearerToken(headerValue(auth.headers, "Authorization")) ?? auth.apiKey;
	if (!resolvedAccess)
		throw new Error("OpenAI Codex OAuth credentials were incomplete.");
	const accountId = verifyCodexStoredOAuthCredential(
		resolvedAccess,
		credentialReader(CODEX_PROVIDER_ID),
	);
	if (model.provider === OPENAI_PROVIDER_ID) {
		const stored = credentialReader(OPENAI_PROVIDER_ID) as { type?: string; access?: string; refresh?: string } | undefined;
		if (!stored || stored.type !== "oauth" || typeof stored.access !== "string" ||
			typeof stored.refresh !== "string" || !stored.refresh || fingerprintResolvedAuth({ apiKey: `Bearer ${stored.access}`, headers: auth.headers }, salt) !== auth.fingerprint) {
			throw new Error("The active OpenAI runtime account does not match Pi\'s stored OAuth account.");
		}
	}
	const authorization = `Bearer ${resolvedAccess}`;
	const headers = {
		Authorization: authorization,
		"chatgpt-account-id": accountId,
	};
	return {
		actualProviderId: model.provider,
		openaiClientId: auth.openaiClientId,
		usageFingerprint: auth.fingerprint,
		apiKey: resolvedAccess,
		headers,
		fingerprint: fingerprintResolvedAuth({ apiKey: auth.fingerprint, headers }, salt),
		secrets: [
			...new Set([...auth.secrets, resolvedAccess, authorization, accountId]),
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
	if (!option.creditId) {
		throw new Error("Account resets require an explicitly selected credit.");
	}
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
					credit_id: option.creditId,
				},
			},
		),
	);
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
