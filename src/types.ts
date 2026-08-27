export type UsageSemanticsKind = "consumer-subscription";
export type UsageUnit = "percent" | "usd" | "count";

export interface UsageModel {
	provider: string;
	id: string;
	name?: string;
	baseUrl?: string;
}

export interface UsageSemantics {
	kind: UsageSemanticsKind;
	label: string;
}

export interface UsageBucket {
	id: string;
	label: string;
	groupId?: string;
	groupLabel?: string;
	modelKeys?: string[];
	used?: number;
	remaining?: number;
	limit?: number;
	unit: UsageUnit;
	period?: string;
	windowMinutes?: number;
	resetsAt?: number;
}

export interface UsageMetric {
	id: string;
	label: string;
	value: number | string;
	unit?: UsageUnit;
}

export interface UsageReport {
	providerId: string;
	providerName: string;
	capturedAt: number;
	source: string;
	semantics: UsageSemantics;
	buckets: UsageBucket[];
	metrics: UsageMetric[];
	notes?: string[];
}

export interface ResolvedUsageAuth {
	actualProviderId: string;
	apiKey?: string;
	headers: Record<string, string>;
	fingerprint: string;
	secrets: string[];
	model: UsageModel;
}

export interface UsageProviderAdapter {
	id: string;
	displayName: string;
	providerIds: readonly string[];
	semantics: UsageSemantics;
	requiresOAuth?: boolean;
	query(
		auth: ResolvedUsageAuth,
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<UsageReport>;
}

export type ProviderUsageState =
	| {
			providerId: string;
			providerName: string;
			status: "ready";
			report: UsageReport;
	  }
	| {
			providerId: string;
			providerName: string;
			status: "unsupported" | "auth-unavailable" | "query-failed";
			message: string;
	  };
