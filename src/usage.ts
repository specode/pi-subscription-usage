import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadUsageConfig } from "./config.ts";
import {
	awaitWithDeadline,
	errorMessage,
	isAbortError,
	modelIdentity,
	UsageCache,
} from "./core.ts";
import {
	DEFAULT_USAGE_DISPLAY_MODE,
	type UsageDisplayMode,
} from "./display.ts";
import {
	CODEX_RESET_CONFIRMATION_OPTIONS,
	codexResetCount,
	formatCodexResetOutcome,
	genericCodexResetOption,
	isCodexResetConfirmed,
	resetOptionExpiration,
	type CodexResetOption,
} from "./codex-reset-core.ts";
import {
	consumeCodexResetCredit,
	listCodexResetCredits,
	resolveCodexResetAuth,
} from "./codex-resets.ts";
import { formatProviderState } from "./format.ts";
import { CODEX_PROVIDER_ID } from "./providers/codex-constants.ts";
import { OPENAI_PROVIDER_ID } from "./providers/openai.ts";
import {
	buildUsageStatusEvent,
	formatUsageStatusline,
	type UsageStatusEvent,
	unavailableUsageStatusEvent,
	USAGE_STATUS_EVENT,
} from "./status.ts";
import {
	adapterForProvider,
	queryProviderUsage,
	resolveUsageAuth,
	UsageUnsupportedError,
} from "./query.ts";
import type {
	ProviderUsageState,
	ResolvedUsageAuth,
	UsageModel,
	UsageProviderAdapter,
} from "./types.ts";

const CACHE_TTL_MS = 5 * 60 * 1_000;
const QUERY_TIMEOUT_MS = 15_000;
const FAILURE_BACKOFF_MS = 30_000;
const STATUS_KEY = "subscription-usage";

type QueryOutcome = {
	state: ProviderUsageState;
	fingerprint?: string;
};

type StableCurrent = {
	outcome: QueryOutcome;
	model: UsageModel | undefined;
};

export default function subscriptionUsage(pi: ExtensionAPI): void {
	const cache = new UsageCache(CACHE_TTL_MS);
	const failureBackoff = new Map<string, { until: number; message: string }>();
	const activeControllers = new Set<AbortController>();
	let sessionActive = false;
	let displayMode: UsageDisplayMode = DEFAULT_USAGE_DISPLAY_MODE;
	let statusGeneration = 0;
	let statusController: AbortController | undefined;
	let statusTimer: ReturnType<typeof setTimeout> | undefined;

	function emitUsageStatus(event: UsageStatusEvent): void {
		pi.events.emit(USAGE_STATUS_EVENT, event);
	}

	function emitUnavailableUsage(): void {
		emitUsageStatus(unavailableUsageStatusEvent());
	}

	function clearStatusTimer(): void {
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = undefined;
	}

	function safeSetStatus(
		ctx: ExtensionContext,
		value: string | undefined,
	): boolean {
		try {
			ctx.ui.setStatus(STATUS_KEY, value);
			return true;
		} catch (error) {
			if (!sessionActive) return false;
			throw error;
		}
	}

	function clearStatus(ctx: ExtensionContext): void {
		statusGeneration += 1;
		statusController?.abort();
		statusController = undefined;
		clearStatusTimer();
		safeSetStatus(ctx, undefined);
		emitUnavailableUsage();
	}

	function scheduleStatusRefresh(
		ctx: ExtensionContext,
		model: UsageModel,
		delayMs = CACHE_TTL_MS,
	): void {
		clearStatusTimer();
		const generation = statusGeneration;
		statusTimer = setTimeout(() => {
			statusTimer = undefined;
			if (!sessionActive || generation !== statusGeneration) return;
			startStatusRefresh(ctx, model, true);
		}, delayMs);
	}

	function publishStatus(
		ctx: ExtensionContext,
		outcome: QueryOutcome,
		model: UsageModel,
		schedule: boolean,
	): void {
		if (outcome.state.status === "unsupported") {
			clearStatusTimer();
			safeSetStatus(ctx, undefined);
			emitUnavailableUsage();
			return;
		}
		if (outcome.state.status !== "ready") {
			emitUnavailableUsage();
			if (
				safeSetStatus(
					ctx,
					outcome.state.status === "auth-unavailable"
						? "usage auth ?"
						: "usage error",
				) &&
				schedule &&
				sessionActive
			) {
				scheduleStatusRefresh(ctx, model);
			}
			return;
		}
		const nowMs = Date.now();
		emitUsageStatus(
			buildUsageStatusEvent(outcome.state.report, model, displayMode, nowMs),
		);
		const value = formatUsageStatusline(
			outcome.state.report,
			model,
			displayMode,
			nowMs,
		);
		if (!safeSetStatus(ctx, value)) return;
		if (schedule && sessionActive) scheduleStatusRefresh(ctx, model);
	}

	async function queryAdapterState(
		ctx: ExtensionContext,
		adapter: UsageProviderAdapter,
		force: boolean,
		signal: AbortSignal,
	): Promise<QueryOutcome> {
		let auth: ResolvedUsageAuth | undefined;
		try {
			auth = await awaitWithDeadline(
				() => resolveUsageAuth(ctx, adapter),
				signal,
				QUERY_TIMEOUT_MS,
				`resolving ${adapter.displayName} authentication`,
			);
		} catch (error) {
			if (isAbortError(error) || !sessionActive) throw error;
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					status: error instanceof UsageUnsupportedError
						? "unsupported"
						: "auth-unavailable",
					message: errorMessage(error),
				},
			};
		}
		if (!auth) {
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					status: "auth-unavailable",
					message: `No Pi runtime credential available for ${adapter.displayName}.`,
				},
			};
		}
		const cached = force ? undefined : cache.get(adapter.id, auth.fingerprint);
		if (cached) {
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					status: "ready",
					report: cached,
				},
				fingerprint: auth.fingerprint,
			};
		}
		const failureKey = `${adapter.id}:${auth.fingerprint}`;
		const failure = failureBackoff.get(failureKey);
		if (!force && failure && failure.until > Date.now()) {
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					status: "query-failed",
					message: failure.message,
				},
				fingerprint: auth.fingerprint,
			};
		}
		failureBackoff.delete(failureKey);
		try {
			const report = await queryProviderUsage(
				adapter,
				auth,
				signal,
				QUERY_TIMEOUT_MS,
			);
			cache.set(adapter.id, auth.fingerprint, report);
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					status: "ready",
					report,
				},
				fingerprint: auth.fingerprint,
			};
		} catch (error) {
			if (isAbortError(error) || !sessionActive) throw error;
			const message = errorMessage(error);
			failureBackoff.set(failureKey, {
				until: Date.now() + FAILURE_BACKOFF_MS,
				message,
			});
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					status: "query-failed",
					message,
				},
				fingerprint: auth.fingerprint,
			};
		}
	}

	async function queryCurrentState(
		ctx: ExtensionContext,
		model: UsageModel | undefined,
		force: boolean,
		signal: AbortSignal,
	): Promise<QueryOutcome> {
		const adapter = adapterForProvider(model?.provider);
		if (!adapter) {
			return {
				state: {
					providerId: model?.provider ?? "none",
					providerName: model?.provider ?? "No model",
					status: "unsupported",
					message: model
						? `${model.provider} is not supported yet.`
						: "No model selected.",
				},
			};
		}
		return queryAdapterState(ctx, adapter, force, signal);
	}

	async function outcomeStillCurrent(
		ctx: ExtensionContext,
		model: UsageModel | undefined,
		outcome: QueryOutcome,
		signal: AbortSignal,
	): Promise<boolean> {
		if (modelIdentity(ctx.model) !== modelIdentity(model)) return false;
		if (!outcome.fingerprint) return true;
		const adapter = adapterForProvider(model?.provider);
		if (!adapter) return false;
		try {
			const auth = await awaitWithDeadline(
				() => resolveUsageAuth(ctx, adapter),
				signal,
				QUERY_TIMEOUT_MS,
				`revalidating ${adapter.displayName} authentication`,
			);
			return (
				modelIdentity(ctx.model) === modelIdentity(model) &&
				auth?.fingerprint === outcome.fingerprint
			);
		} catch (error) {
			if (isAbortError(error) || !sessionActive) throw error;
			return false;
		}
	}

	async function queryStableCurrent(
		ctx: ExtensionContext,
		force: boolean,
		signal: AbortSignal,
	): Promise<StableCurrent | undefined> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const model = ctx.model;
			const outcome = await queryCurrentState(ctx, model, force, signal);
			if (await outcomeStillCurrent(ctx, model, outcome, signal)) {
				return { outcome, model };
			}
			force = false;
		}
		return undefined;
	}

	async function refreshCurrentStatus(
		ctx: ExtensionContext,
		model: UsageModel | undefined,
		force: boolean,
	): Promise<void> {
		if (!adapterForProvider(model?.provider) || !model) {
			clearStatus(ctx);
			return;
		}
		statusGeneration += 1;
		const generation = statusGeneration;
		statusController?.abort();
		const controller = new AbortController();
		statusController = controller;
		activeControllers.add(controller);
		const refreshIsCurrent = (): boolean =>
			sessionActive &&
			generation === statusGeneration &&
			!controller.signal.aborted &&
			modelIdentity(ctx.model) === modelIdentity(model);
		try {
			safeSetStatus(ctx, "usage …");
			const outcome = await queryCurrentState(
				ctx,
				model,
				force,
				controller.signal,
			);
			if (
				!refreshIsCurrent() ||
				!(await outcomeStillCurrent(ctx, model, outcome, controller.signal))
			) {
				return;
			}
			publishStatus(ctx, outcome, model, true);
		} catch (error) {
			if (isAbortError(error) || !refreshIsCurrent()) return;
			try {
				emitUnavailableUsage();
			} catch {
				// A status consumer must not stop future refreshes.
			}
			if (!refreshIsCurrent()) return;
			try {
				safeSetStatus(ctx, "usage error");
			} catch {
				// Error reporting must not stop future refreshes.
			}
			if (refreshIsCurrent()) {
				scheduleStatusRefresh(ctx, model, FAILURE_BACKOFF_MS);
			}
		} finally {
			activeControllers.delete(controller);
			if (statusController === controller) statusController = undefined;
		}
	}

	function startStatusRefresh(
		ctx: ExtensionContext,
		model: UsageModel | undefined,
		force: boolean,
	): void {
		void refreshCurrentStatus(ctx, model, force).catch(() => {
			// Unsupported-model cleanup is best effort during UI teardown.
		});
	}

	async function redeemCodexReset(
		ctx: ExtensionCommandContext,
		current: StableCurrent,
		controller: AbortController,
	): Promise<StableCurrent | undefined> {
		if (
			![CODEX_PROVIDER_ID, OPENAI_PROVIDER_ID].includes(ctx.model?.provider ?? "") ||
			current.outcome.state.status !== "ready"
		) {
			ctx.ui.notify(
				"Account resets require the current OpenAI or Codex OAuth account.",
				"warning",
			);
			return undefined;
		}
		const expectedModel = modelIdentity(current.model);
		const isOpenAI = current.model?.provider === OPENAI_PROVIDER_ID;
		const resetLabel = isOpenAI ? "Account" : "Codex";
		if (modelIdentity(ctx.model) !== expectedModel) throw new Error("Model changed; reset cancelled.");
		const summaryCount = codexResetCount(current.outcome.state.report) ?? 0;
		let auth = await awaitWithDeadline(
			() => resolveCodexResetAuth(ctx),
			controller.signal,
			QUERY_TIMEOUT_MS,
			"resolving Codex reset authentication",
		);
		if (auth.usageFingerprint !== current.outcome.fingerprint) {
			throw new Error("Account changed since usage was displayed; run /usage again.");
		}
		let availability;
		try {
			availability = await listCodexResetCredits(
				auth,
				controller.signal,
				QUERY_TIMEOUT_MS,
			);
		} catch (error) {
			if (isOpenAI || isAbortError(error) || summaryCount <= 0) throw error;
			availability = {
				availableCount: summaryCount,
				options: [genericCodexResetOption()],
			};
		}
		if (availability.availableCount <= 0 || availability.options.length === 0) {
			ctx.ui.notify("No Codex reset credits available.", "info");
			return undefined;
		}
		const labels = availability.options.map(
			(option: CodexResetOption, index: number) =>
				`${index + 1}. ${option.title} · ${resetOptionExpiration(option)}`,
		);
		const selected = await ctx.ui.select(`Choose a ${resetLabel} Reset`, labels);
		if (!selected) return undefined;
		const option = availability.options[labels.indexOf(selected)];
		if (!option) return undefined;
		const confirmation = await ctx.ui.select(
			`Redeem one ${resetLabel} reset?\n${option.title}\n${option.description}\n${resetOptionExpiration(option)}${isOpenAI ? "\nConsumes a reset from the companion Codex account. Only ticket-supported account windows are reset; clearing this app's quota is not guaranteed." : ""}`,
			[...CODEX_RESET_CONFIRMATION_OPTIONS],
		);
		if (!isCodexResetConfirmed(confirmation)) return undefined;

		const expectedFingerprint = auth.fingerprint;
		const requestId = randomUUID();
		let submitted = false;
		while (!controller.signal.aborted) {
			try {
				auth = await awaitWithDeadline(
					() => resolveCodexResetAuth(ctx),
					controller.signal,
					QUERY_TIMEOUT_MS,
					"revalidating Codex reset authentication",
				);
				if (
					modelIdentity(ctx.model) !== expectedModel ||
					auth.fingerprint !== expectedFingerprint
				) {
					throw new Error("Model or account changed; reset not submitted.");
				}
				if (isOpenAI) {
					await queryProviderUsage(adapterForProvider(OPENAI_PROVIDER_ID)!, auth, controller.signal, QUERY_TIMEOUT_MS);
					const checked = await awaitWithDeadline(() => resolveCodexResetAuth(ctx), controller.signal, QUERY_TIMEOUT_MS, "revalidating account reset authentication");
					if (checked.fingerprint !== expectedFingerprint || modelIdentity(ctx.model) !== expectedModel) {
						throw new Error("OpenAI or Codex account changed; reset not submitted.");
					}
					auth = checked;
				}
			} catch (error) {
				if (isAbortError(error) || !sessionActive) throw error;
				if (!submitted) throw error;
				// A previous POST may have succeeded even though its response was lost.
				ctx.ui.notify("Reset result uncertain; retry stopped during account or usage verification. Run /usage to check your quota and reset credits.", "warning");
				return undefined;
			}

			let outcome;
			try {
				submitted = true;
				outcome = await consumeCodexResetCredit(
					auth,
					option,
					requestId,
					controller.signal,
					QUERY_TIMEOUT_MS,
				);
			} catch (error) {
				if (isAbortError(error) || !sessionActive) throw error;
				const retryAction = "Retry with Same Request ID";
				const retry = await ctx.ui.select("Reset Result Uncertain", [
					retryAction,
					"Cancel",
				]);
				if (retry !== retryAction) {
					ctx.ui.notify(`Reset result uncertain; run /usage to check your quota and reset credits. ${errorMessage(error)}`, "warning");
					return undefined;
				}
				continue;
			}

			// A confirmed consume result must never become another consume retry.
			cache.clearProvider(CODEX_PROVIDER_ID);
			cache.clearProvider(OPENAI_PROVIDER_ID);
			failureBackoff.clear();
			ctx.ui.notify(formatCodexResetOutcome(outcome, undefined), "info");
			try {
				const refreshed = await queryStableCurrent(ctx, true, controller.signal);
				if (!refreshed || refreshed.outcome.state.status !== "ready") {
					ctx.ui.notify("Reset result confirmed, but usage refresh failed. Run /usage again.", "warning");
				}
				if (refreshed?.model) {
					publishStatus(ctx, refreshed.outcome, refreshed.model, sessionActive);
				}
				return refreshed;
			} catch (error) {
				if (isAbortError(error) || !sessionActive) throw error;
				ctx.ui.notify("Reset result confirmed, but usage refresh or display failed. Run /usage again.", "warning");
				return undefined;
			}
		}
		return undefined;
	}

	async function showUsage(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) throw new Error("/usage requires TUI or RPC mode.");
		const controller = new AbortController();
		activeControllers.add(controller);
		try {
			const current = await queryStableCurrent(ctx, true, controller.signal);
			if (!current) {
				ctx.ui.notify(
					"Model or account keeps changing; run /usage again.",
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				formatProviderState(current.outcome.state, displayMode),
				"info",
			);
			if (current.model) {
				publishStatus(ctx, current.outcome, current.model, sessionActive);
			}
			if (
				![CODEX_PROVIDER_ID, OPENAI_PROVIDER_ID].includes(ctx.model?.provider ?? "") ||
				current.outcome.state.status !== "ready"
			) {
				return;
			}
			const resetCount = codexResetCount(current.outcome.state.report) ?? 0;
			if (resetCount <= 0) return;
			const action = await ctx.ui.select(
				`Reset Credits: ${resetCount} Available`,
				["Redeem 1 Reset"],
			);
			if (!action) return;
			const refreshed = await redeemCodexReset(ctx, current, controller);
			if (refreshed?.outcome.state.status === "ready") {
				ctx.ui.notify(
					formatProviderState(refreshed.outcome.state, displayMode),
					"info",
				);
			}
		} finally {
			controller.abort();
			activeControllers.delete(controller);
		}
	}

	pi.registerCommand("usage", {
		description: "Show subscription usage for the current provider",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("/usage takes no arguments.", "warning");
				return;
			}
			try {
				await showUsage(ctx);
			} catch (error) {
				if (isAbortError(error) || !sessionActive) return;
				ctx.ui.notify(`Usage query failed: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		sessionActive = ctx.hasUI;
		const config = loadUsageConfig(ctx.cwd, ctx.isProjectTrusted());
		displayMode = config.displayMode;
		for (const warning of config.warnings) {
			ctx.ui.notify(`Usage config ignored: ${warning}`, "warning");
		}
		if (ctx.hasUI) startStatusRefresh(ctx, ctx.model, false);
	});
	pi.on("session_tree", (_event, ctx) => {
		if (ctx.hasUI) startStatusRefresh(ctx, ctx.model, false);
	});
	pi.on("model_select", (event, ctx) => {
		if (!ctx.hasUI) return;
		emitUnavailableUsage();
		startStatusRefresh(ctx, event.model, false);
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.hasUI) startStatusRefresh(ctx, ctx.model, false);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		sessionActive = false;
		statusGeneration += 1;
		clearStatusTimer();
		for (const controller of activeControllers) controller.abort();
		activeControllers.clear();
		statusController = undefined;
		cache.clear();
		failureBackoff.clear();
		safeSetStatus(ctx, undefined);
		emitUnavailableUsage();
	});
}
