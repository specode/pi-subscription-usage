import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	parseUsageConfig,
	resolveUsageConfig,
	type UsageConfig,
} from "./config-core.ts";

const CONFIG_FILE_NAME = "subscription-usage.json";

export interface LoadedUsageConfig extends UsageConfig {
	warnings: string[];
}

export function loadUsageConfig(
	cwd: string,
	includeProjectConfig: boolean,
): LoadedUsageConfig {
	const warnings: string[] = [];
	const globalConfig = readConfigFile(
		join(getAgentDir(), CONFIG_FILE_NAME),
		warnings,
	);
	const projectConfig = includeProjectConfig
		? readConfigFile(join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME), warnings)
		: undefined;
	return {
		...resolveUsageConfig(globalConfig, projectConfig),
		warnings,
	};
}

function readConfigFile(
	path: string,
	warnings: string[],
): ReturnType<typeof parseUsageConfig> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = parseUsageConfig(JSON.parse(readFileSync(path, "utf8")));
		if (parsed.warning) warnings.push(`${path}: ${parsed.warning}`);
		return parsed;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnings.push(`${path}: ${message}`);
		return undefined;
	}
}
