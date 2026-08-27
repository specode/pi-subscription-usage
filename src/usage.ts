import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	awaitWithDeadline,
	errorMessage,
	isAbortError,
	isStaleContextError,
	modelIdentity,
	UsageCache,
} from "./core.ts";
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
			if (isStaleContextError(error)) return false;
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
	): void {
		clearStatusTimer();
		const generation = statusGeneration;
		statusTimer = setTimeout(() => {
			statusTimer = undefined;
			if (!sessionActive || generation !== statusGeneration) return;
			startStatusRefresh(ctx, model, true);
		}, CACHE_TTL_MS);
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
		emitUsageStatus(buildUsageStatusEvent(outcome.state.report, model));
		const value = formatUsageStatusline(outcome.state.report, model);
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
				resolveUsageAuth(ctx, adapter),
				signal,
				QUERY_TIMEOUT_MS,
				`resolving ${adapter.displayName} authentication`,
			);
		} catch (error) {
			if (isAbortError(error) || isStaleContextError(error)) throw error;
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					status: "auth-unavailable",
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
			if (isAbortError(error) || isStaleContextError(error)) throw error;
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
				resolveUsageAuth(ctx, adapter),
				signal,
				QUERY_TIMEOUT_MS,
				`revalidating ${adapter.displayName} authentication`,
			);
			return (
				modelIdentity(ctx.model) === modelIdentity(model) &&
				auth?.fingerprint === outcome.fingerprint
			);
		} catch (error) {
			if (isAbortError(error) || isStaleContextError(error)) throw error;
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
		try {
			safeSetStatus(ctx, "usage …");
			const outcome = await queryCurrentState(
				ctx,
				model,
				force,
				controller.signal,
			);
			if (
				!sessionActive ||
				generation !== statusGeneration ||
				controller.signal.aborted ||
				!(await outcomeStillCurrent(ctx, model, outcome, controller.signal))
			) {
				return;
			}
			publishStatus(ctx, outcome, model, true);
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
		void refreshCurrentStatus(ctx, model, force).catch((error) => {
			if (isAbortError(error) || isStaleContextError(error)) return;
			emitUnavailableUsage();
			safeSetStatus(ctx, "usage error");
		});
	}

	async function redeemCodexReset(
		ctx: ExtensionCommandContext,
		current: StableCurrent,
		controller: AbortController,
	): Promise<StableCurrent | undefined> {
		if (
			ctx.model?.provider !== "openai-codex" ||
			current.outcome.state.status !== "ready"
		) {
			ctx.ui.notify(
				"Codex resets only work with the current Codex OAuth account.",
				"warning",
			);
			return undefined;
		}
		const summaryCount = codexResetCount(current.outcome.state.report) ?? 0;
		let auth = await awaitWithDeadline(
			resolveCodexResetAuth(ctx),
			controller.signal,
			QUERY_TIMEOUT_MS,
			"resolving Codex reset authentication",
		);
		let availability;
		try {
			availability = await listCodexResetCredits(
				auth,
				controller.signal,
				QUERY_TIMEOUT_MS,
			);
		} catch (error) {
			if (summaryCount <= 0) throw error;
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
		const selected = await ctx.ui.select("Choose a Codex Reset", labels);
		if (!selected) return undefined;
		const option = availability.options[labels.indexOf(selected)];
		if (!option) return undefined;
		const confirmation = await ctx.ui.select(
			`Redeem one Codex reset?\n${option.title}\n${option.description}\n${resetOptionExpiration(option)}`,
			[...CODEX_RESET_CONFIRMATION_OPTIONS],
		);
		if (!isCodexResetConfirmed(confirmation)) return undefined;

		const expectedModel = modelIdentity(ctx.model);
		const expectedFingerprint = auth.fingerprint;
		const requestId = randomUUID();
		while (!controller.signal.aborted) {
			auth = await awaitWithDeadline(
				resolveCodexResetAuth(ctx),
				controller.signal,
				QUERY_TIMEOUT_MS,
				"revalidating Codex reset authentication",
			);
			if (
				modelIdentity(ctx.model) !== expectedModel ||
				auth.fingerprint !== expectedFingerprint
			) {
				throw new Error("Codex model or account changed; reset not redeemed.");
			}
			try {
				const outcome = await consumeCodexResetCredit(
					auth,
					option,
					requestId,
					controller.signal,
					QUERY_TIMEOUT_MS,
				);
				cache.clearProvider("openai-codex");
				failureBackoff.clear();
				const refreshed = await queryStableCurrent(ctx, true, controller.signal);
				if (refreshed?.model) {
					publishStatus(ctx, refreshed.outcome, refreshed.model, sessionActive);
				}
				const remaining =
					refreshed?.outcome.state.status === "ready"
						? codexResetCount(refreshed.outcome.state.report)
						: undefined;
				ctx.ui.notify(formatCodexResetOutcome(outcome, remaining), "info");
				return refreshed;
			} catch (error) {
				if (isAbortError(error) || isStaleContextError(error)) throw error;
				const retryAction = "Retry with Same Request ID";
				const retry = await ctx.ui.select("Reset Result Uncertain", [
					retryAction,
					"Cancel",
				]);
				if (retry !== retryAction) {
					ctx.ui.notify(`Reset not confirmed: ${errorMessage(error)}`, "warning");
					return undefined;
				}
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
			ctx.ui.notify(formatProviderState(current.outcome.state), "info");
			if (current.model) {
				publishStatus(ctx, current.outcome, current.model, sessionActive);
			}
			if (
				ctx.model?.provider !== "openai-codex" ||
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
				ctx.ui.notify(formatProviderState(refreshed.outcome.state), "info");
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
				if (isAbortError(error) || isStaleContextError(error)) return;
				ctx.ui.notify(`Usage query failed: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		sessionActive = ctx.hasUI;
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
