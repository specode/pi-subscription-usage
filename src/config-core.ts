import {
	DEFAULT_USAGE_DISPLAY_MODE,
	type UsageDisplayMode,
} from "./display.ts";

export interface UsageConfig {
	displayMode: UsageDisplayMode;
}

export interface ParsedUsageConfig {
	displayMode?: UsageDisplayMode;
	warning?: string;
}

export const DEFAULT_USAGE_CONFIG: UsageConfig = {
	displayMode: DEFAULT_USAGE_DISPLAY_MODE,
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
	};
}

export function parseUsageConfig(value: unknown): ParsedUsageConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { warning: "configuration must be a JSON object" };
	}
	const displayMode = (value as Record<string, unknown>).displayMode;
	if (displayMode === undefined) return {};
	if (displayMode !== "remaining" && displayMode !== "used") {
		return {
			warning: 'displayMode must be either "remaining" or "used"',
		};
	}
	return { displayMode };
}
