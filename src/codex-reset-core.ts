// Adapted from @narumitw/pi-usage@0.53.0 (MIT).
import { sanitizeDisplayText } from "./core.ts";
import type { UsageReport } from "./types.ts";

export type CodexResetOutcomeCode =
	| "reset"
	| "nothing_to_reset"
	| "no_credit"
	| "already_redeemed";

export interface CodexResetOption {
	creditId?: string;
	title: string;
	description: string;
	expiresAt?: number;
}

export interface CodexResetAvailability {
	availableCount: number;
	options: CodexResetOption[];
}

export interface CodexResetOutcome {
	code: CodexResetOutcomeCode;
	windowsReset: number;
}

export const CODEX_RESET_CONFIRMATION_OPTIONS = [
	"Cancel (Default)",
	"Redeem 1 Reset (Irreversible)",
] as const;

export function isCodexResetConfirmed(value: string | undefined): boolean {
	return value === CODEX_RESET_CONFIRMATION_OPTIONS[1];
}

export function codexResetCount(report: UsageReport): number | undefined {
	const value = report.metrics.find(
		(metric) => metric.id === "reset-credits",
	)?.value;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

export function genericCodexResetOption(): CodexResetOption {
	return {
		title: "Full Reset",
		description: "Resets the current usage windows.",
	};
}

export function resetOptionExpiration(option: CodexResetOption): string {
	if (option.expiresAt === undefined) return "No Expiry";
	const expiration = new Date(option.expiresAt * 1_000);
	return Number.isNaN(expiration.getTime())
		? "Expiry Unavailable"
		: `Expires ${expiration.toLocaleString("en-US")}`;
}

export function formatCodexResetOutcome(
	outcome: CodexResetOutcome | undefined,
	remainingCount: number | undefined,
): string {
	const remaining =
		remainingCount === undefined ? "" : `, ${remainingCount} left`;
	if (!outcome) return "No reset credits available.";
	if (outcome.code === "reset") return `Reset redeemed${remaining}.`;
	if (outcome.code === "already_redeemed") {
		return `Reset already redeemed${remaining}.`;
	}
	if (outcome.code === "nothing_to_reset") return "Nothing to reset right now.";
	return "No reset credits available.";
}

export function normalizeCodexResetCreditsPayload(
	payload: Record<string, unknown>,
): CodexResetAvailability {
	const availableCount = nonnegativeInteger(payload.available_count);
	if (availableCount === undefined) {
		throw new Error(
			"Codex reset credits response returned an invalid available_count.",
		);
	}
	if (payload.credits !== undefined && !Array.isArray(payload.credits)) {
		throw new Error("Codex reset credits response returned invalid credits.");
	}
	const options: CodexResetOption[] = [];
	for (const rawCredit of payload.credits ?? []) {
		const credit = asObject(rawCredit);
		if (
			!credit ||
			credit.status !== "available" ||
			credit.reset_type !== "codex_rate_limits"
		) {
			continue;
		}
		options.push(normalizeResetOption(credit));
	}
	options.sort(
		(left, right) =>
			(left.expiresAt ?? Number.MAX_SAFE_INTEGER) -
			(right.expiresAt ?? Number.MAX_SAFE_INTEGER),
	);
	options.splice(Math.min(availableCount, 32));
	if (availableCount > 0 && options.length === 0)
		options.push(genericCodexResetOption());
	return { availableCount, options };
}

export function parseCodexResetOutcome(
	payload: Record<string, unknown>,
): CodexResetOutcome {
	const code = payload.code;
	if (!isOutcomeCode(code)) {
		throw new Error(
			"Codex reset consume endpoint returned an unknown outcome code.",
		);
	}
	const windowsReset =
		payload.windows_reset === undefined
			? 0
			: nonnegativeInteger(payload.windows_reset);
	if (windowsReset === undefined) {
		throw new Error(
			"Codex reset consume endpoint returned an invalid windows_reset value.",
		);
	}
	return { code, windowsReset };
}

function normalizeResetOption(
	credit: Record<string, unknown>,
): CodexResetOption {
	const creditId = opaqueId(credit.id);
	if (!creditId)
		throw new Error(
			"Codex reset credits response returned an invalid credit ID.",
		);
	let expiresAt: number | undefined;
	if (credit.expires_at !== undefined && credit.expires_at !== null) {
		if (typeof credit.expires_at !== "string") {
			throw new Error(
				"Codex reset credits response returned an invalid expiration time.",
			);
		}
		const parsed = Date.parse(credit.expires_at);
		if (!Number.isFinite(parsed)) {
			throw new Error(
				"Codex reset credits response returned an invalid expiration time.",
			);
		}
		expiresAt = Math.floor(parsed / 1_000);
	}
	return {
		creditId,
		title: displayString(credit.title) ?? "Full Reset",
		description:
			displayString(credit.description) ?? "Resets the current usage windows.",
		...(expiresAt === undefined ? {} : { expiresAt }),
	};
}

function isOutcomeCode(value: unknown): value is CodexResetOutcomeCode {
	return ["reset", "nothing_to_reset", "no_credit", "already_redeemed"].includes(
		value as string,
	);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function opaqueId(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 1_024
		? value
		: undefined;
}

function displayString(value: unknown): string | undefined {
	return typeof value === "string"
		? sanitizeDisplayText(value, 160) || undefined
		: undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
	let parsed = Number.NaN;
	if (typeof value === "number") parsed = value;
	else if (typeof value === "string" && value.trim()) parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
