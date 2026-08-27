// Adapted from @narumitw/pi-usage@0.53.0 (MIT).
import { createHmac } from "node:crypto";
import type { UsageReport } from "./types.ts";

export class UsageCache {
	private readonly entries = new Map<
		string,
		{ createdAt: number; report: UsageReport }
	>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;

	constructor(ttlMs: number, maxEntries = 32) {
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
			throw new Error("Cache TTL must be positive.");
		}
		if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
			throw new Error("Cache entry limit must be a positive integer.");
		}
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
	}

	get(
		providerId: string,
		fingerprint: string,
		now = Date.now(),
	): UsageReport | undefined {
		this.sweepExpired(now);
		return this.entries.get(cacheKey(providerId, fingerprint))?.report;
	}

	set(
		providerId: string,
		fingerprint: string,
		report: UsageReport,
		now = Date.now(),
	): void {
		this.sweepExpired(now);
		const key = cacheKey(providerId, fingerprint);
		this.entries.delete(key);
		while (this.entries.size >= this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
		this.entries.set(key, { createdAt: now, report });
	}

	clearProvider(providerId: string): void {
		for (const key of this.entries.keys()) {
			if (key.startsWith(`${providerId}:`)) this.entries.delete(key);
		}
	}

	clear(): void {
		this.entries.clear();
	}

	private sweepExpired(now: number): void {
		for (const [key, entry] of this.entries) {
			if (now - entry.createdAt >= this.ttlMs) this.entries.delete(key);
		}
	}
}

export function fingerprintResolvedAuth(
	auth: { apiKey?: string; headers?: Record<string, string> },
	salt: Uint8Array,
): string {
	const headers = Object.entries(auth.headers ?? {})
		.map(([name, value]) => [name.toLowerCase(), value] as const)
		.sort(([left], [right]) => left.localeCompare(right));
	return createHmac("sha256", salt)
		.update(JSON.stringify({ apiKey: auth.apiKey ?? "", headers }))
		.digest("hex");
}

export async function awaitWithDeadline<T>(
	operation: Promise<T>,
	signal: AbortSignal,
	timeoutMs: number,
	description: string,
): Promise<T> {
	if (signal.aborted) throw abortError();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => {
					reject(
						Object.assign(
							new Error(
								`Timed out after ${Math.round(timeoutMs / 1_000)}s ${description}.`,
							),
							{ name: "TimeoutError" },
						),
					);
				}, timeoutMs);
				abortListener = () => reject(abortError());
				signal.addEventListener("abort", abortListener, { once: true });
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (abortListener) signal.removeEventListener("abort", abortListener);
	}
}

export function sanitizeDisplayText(value: string, maxChars = 160): string {
	const plain = value
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/gu, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
		.replace(/[\t\r\n]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return plain.length <= maxChars
		? plain
		: `${plain.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function redactUsageError(
	value: string,
	secrets: readonly string[] = [],
): string {
	let redacted = value;
	for (const secret of [...new Set(secrets)]
		.filter(Boolean)
		.sort((a, b) => b.length - a.length)) {
		redacted = redacted.replace(
			new RegExp(escapeRegExp(secret), "gu"),
			"<redacted>",
		);
	}
	redacted = redacted
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>")
		.replace(
			/"(?:access_token|refresh_token|api_key)"\s*:\s*"[^"]+"/giu,
			(match) => {
				const separator = match.indexOf(":");
				return `${match.slice(0, separator + 1)}"<redacted>"`;
			},
		);
	return sanitizeDisplayText(redacted, 600);
}

export function errorMessage(error: unknown): string {
	return sanitizeDisplayText(
		error instanceof Error ? error.message : String(error),
		600,
	);
}

export function abortError(): Error {
	return Object.assign(new Error("Usage query aborted."), {
		name: "AbortError",
	});
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

export function isStaleContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes(
			"This extension ctx is stale after session replacement or reload",
		)
	);
}

export function modelIdentity(
	model: { provider: string; id: string } | undefined,
): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function cacheKey(providerId: string, fingerprint: string): string {
	return `${providerId}:${fingerprint}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
