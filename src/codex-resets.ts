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
	const accountId = verifyCodexStoredOAuthCredential(
		resolvedAccess,
		credentialReader("openai-codex"),
	);
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
