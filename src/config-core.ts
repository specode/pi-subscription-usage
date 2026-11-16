import {
	DEFAULT_USAGE_DISPLAY_MODE,
	type UsageDisplayMode,
} from "./display.ts";

export interface UsageConfig {
	displayMode: UsageDisplayMode;
	/** `/usage` lists every signed-in provider instead of the active one. */
	showAllProviders: boolean;
	/** `/usage` offers to redeem a reset credit when the account has one. */
	offerResetCredits: boolean;
	/** Minutes a report is reused for the providers after the active one; 0 fetches each time. */
	showAllProvidersCacheMinutes: number;
}

export interface ParsedUsageConfig {
	displayMode?: UsageDisplayMode;
	showAllProviders?: boolean;
	offerResetCredits?: boolean;
	showAllProvidersCacheMinutes?: number;
	warning?: string;
}

export const DEFAULT_USAGE_CONFIG: UsageConfig = {
	displayMode: DEFAULT_USAGE_DISPLAY_MODE,
	showAllProviders: false,
	offerResetCredits: true,
	showAllProvidersCacheMinutes: 5,
};

export function resolveUsageConfig(
	globalConfig?: ParsedUsageConfig,
	projectConfig?: ParsedUsageConfig,
): UsageConfig {
	return {
		displayMode:
			projectConfig?.displayMode ??
			globalConfig?.displayMode ??
			DEFAULT_USAGE_CONFIG.displayMode,
		showAllProviders:
			projectConfig?.showAllProviders ??
			globalConfig?.showAllProviders ??
			DEFAULT_USAGE_CONFIG.showAllProviders,
		offerResetCredits:
			projectConfig?.offerResetCredits ??
			globalConfig?.offerResetCredits ??
			DEFAULT_USAGE_CONFIG.offerResetCredits,
		showAllProvidersCacheMinutes:
			projectConfig?.showAllProvidersCacheMinutes ??
			globalConfig?.showAllProvidersCacheMinutes ??
			DEFAULT_USAGE_CONFIG.showAllProvidersCacheMinutes,
	};
}

export function parseUsageConfig(value: unknown): ParsedUsageConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { warning: "configuration must be a JSON object" };
	}
	const record = value as Record<string, unknown>;
	const displayMode = record.displayMode;
	const showAllProviders = record.showAllProviders;
	const offerResetCredits = record.offerResetCredits;
	const showAllProvidersCacheMinutes = record.showAllProvidersCacheMinutes;
	if (displayMode !== undefined && displayMode !== "remaining" && displayMode !== "used") {
		return {
			warning: 'displayMode must be either "remaining" or "used"',
		};
	}
	if (showAllProviders !== undefined && typeof showAllProviders !== "boolean") {
		return { warning: "showAllProviders must be true or false" };
	}
	if (offerResetCredits !== undefined && typeof offerResetCredits !== "boolean") {
		return { warning: "offerResetCredits must be true or false" };
	}
	if (
		showAllProvidersCacheMinutes !== undefined &&
		(typeof showAllProvidersCacheMinutes !== "number" ||
			!Number.isFinite(showAllProvidersCacheMinutes) ||
			showAllProvidersCacheMinutes < 0)
	) {
		return {
			warning:
				"showAllProvidersCacheMinutes must be 0 or more",
		};
	}
	return {
		...(displayMode === undefined ? {} : { displayMode }),
		...(showAllProviders === undefined ? {} : { showAllProviders }),
		...(offerResetCredits === undefined ? {} : { offerResetCredits }),
		...(showAllProvidersCacheMinutes === undefined
			? {}
			: { showAllProvidersCacheMinutes }),
	};
}
