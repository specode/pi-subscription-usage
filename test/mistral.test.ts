import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageReport } from "../src/format.ts";
import {
	MISTRAL_API_GROUP_ID,
	MISTRAL_BUDGET_URL,
	MISTRAL_LEGACY_PROVIDER_ID,
	MISTRAL_PROVIDER_ID,
	MISTRAL_SUBSCRIPTION_URL,
	MISTRAL_VIBE_GROUP_ID,
	normalizeMistralUsage,
} from "../src/providers/mistral.ts";
import {
	adapterForProvider,
	queryProviderUsage,
	UsageUnsupportedError,
} from "../src/query.ts";
import { formatUsageStatusline } from "../src/status.ts";
import type { ResolvedUsageAuth } from "../src/types.ts";

const capturedAt = Date.parse("2026-11-20T10:00:00Z");

const FIXTURE_BUDGET = {
	vibe_budget: {
		usage_percentage: 0.07373884133333333,
		initial_budget: 300,
		currency: "USD",
		reset_at: "2026-12-01T00:00:00Z",
		payg_enabled: false,
	},
	api_budget: {
		usage_percentage: 25,
		initial_budget: 30,
		currency: "USD",
		reset_at: "2026-12-01T00:00:00Z",
		payg_enabled: false,
	},
	usage_percentage: 25,
	initial_budget: 30,
	currency: "USD",
	reset_at: "2026-12-01T00:00:00Z",
};

const FIXTURE_SUBSCRIPTION = {
	plan_name: "INDIVIDUAL",
	payg_enabled: false,
	vibe_payg_enabled: false,
	enterprise: false,
};

test("normalizes the Vibe Code and API budgets", () => {
	const report = normalizeMistralUsage(
		FIXTURE_BUDGET,
		capturedAt,
		FIXTURE_SUBSCRIPTION,
	);
	assert.equal(report.providerId, MISTRAL_PROVIDER_ID);
	assert.equal(report.providerName, "Mistral");
	assert.equal(report.defaultGroupId, MISTRAL_VIBE_GROUP_ID);
	assert.deepEqual(
		report.buckets.map((bucket) => [
			bucket.groupId,
			bucket.unit,
			bucket.used,
			bucket.remaining,
			bucket.limit,
		]),
		[
			[MISTRAL_VIBE_GROUP_ID, "usd", 0.22, 299.78, 300],
			[MISTRAL_API_GROUP_ID, "usd", 7.5, 22.5, 30],
		],
	);
	assert.equal(report.buckets[0]?.windowMinutes, 43_200);
	assert.equal(report.buckets[0]?.resetsAt, Date.parse("2026-12-01T00:00:00Z") / 1_000);
	assert.deepEqual(report.metrics, [
		{ id: "plan", label: "Plan", value: "Individual" },
		{ id: "payg", label: "Pay-as-you-go", value: "off" },
	]);
});

test("keeps the footer on the Vibe Code budget", () => {
	const report = normalizeMistralUsage(
		FIXTURE_BUDGET,
		capturedAt,
		FIXTURE_SUBSCRIPTION,
	);
	assert.equal(
		formatUsageStatusline(
			report,
			{ provider: MISTRAL_PROVIDER_ID, id: "mistral-large-4" },
			"remaining",
			capturedAt,
		),
		"1m 100% ↻10d14h",
	);
});

test("shows a USD budget in dollars", () => {
	const report = normalizeMistralUsage(FIXTURE_BUDGET, capturedAt);
	const text = formatUsageReport(report);
	assert.match(text, /\$299\.78\/\$300\.00/u);
	assert.match(text, /\$22\.50\/\$30\.00/u);
});

test("falls back to the legacy top-level budget", () => {
	const report = normalizeMistralUsage(
		{
			usage_percentage: 40,
			initial_budget: 25,
			currency: "USD",
			reset_at: "2026-12-01T00:00:00Z",
		},
		capturedAt,
	);
	assert.equal(report.defaultGroupId, MISTRAL_VIBE_GROUP_ID);
	assert.equal(report.buckets.length, 1);
	assert.equal(report.buckets[0]?.used, 10);
	assert.equal(report.buckets[0]?.remaining, 15);
});

test("does not read the top-level mirror as a second Vibe Code budget", () => {
	const report = normalizeMistralUsage(
		{ ...FIXTURE_BUDGET, vibe_budget: undefined },
		capturedAt,
	);
	assert.equal(report.defaultGroupId, MISTRAL_API_GROUP_ID);
	assert.deepEqual(
		report.buckets.map((bucket) => bucket.groupId),
		[MISTRAL_API_GROUP_ID],
	);
});

test("keeps a non-USD budget as a percentage with its allowance", () => {
	const report = normalizeMistralUsage(
		{
			vibe_budget: {
				usage_percentage: 12.5,
				initial_budget: 200,
				currency: "eur",
				reset_at: "2026-12-01T00:00:00Z",
			},
		},
		capturedAt,
	);
	assert.equal(report.buckets[0]?.unit, "percent");
	assert.equal(report.buckets[0]?.used, 12.5);
	assert.equal(report.buckets[0]?.remaining, 87.5);
	assert.deepEqual(report.metrics, [
		{ id: "vibe-code-allowance", label: "Vibe Code allowance", value: "200 EUR" },
	]);
});

test("rejects a budget without a usable allowance", () => {
	assert.throws(
		() => normalizeMistralUsage({ vibe_budget: { usage_percentage: 10 } }, capturedAt),
		/Mistral budget endpoint returned no displayable allowance/u,
	);
	assert.throws(
		() => normalizeMistralUsage({ vibe_budget: { initial_budget: 300 } }, capturedAt),
		/Mistral budget endpoint returned no displayable allowance/u,
	);
	assert.throws(() => normalizeMistralUsage([], capturedAt), /was not an object/u);
});

test("reads the Mistral billing endpoints for the subscription budget", async () => {
	const adapter = adapterForProvider(MISTRAL_PROVIDER_ID);
	assert.ok(adapter);
	const calls: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (input) => {
		const url = String(input);
		calls.push(url);
		return jsonResponse(
			url === MISTRAL_SUBSCRIPTION_URL ? FIXTURE_SUBSCRIPTION : FIXTURE_BUDGET,
		);
	};
	try {
		const report = await queryProviderUsage(
			adapter,
			mistralAuth(),
			new AbortController().signal,
			5_000,
		);
		assert.deepEqual(calls, [MISTRAL_SUBSCRIPTION_URL, MISTRAL_BUDGET_URL]);
		assert.equal(report.providerId, MISTRAL_PROVIDER_ID);
		assert.equal(report.buckets[0]?.remaining, 299.78);
	} finally {
		globalThis.fetch = original;
	}
});

test("recognizes the deprecated mistral-subscription provider id", () => {
	assert.equal(
		adapterForProvider(MISTRAL_LEGACY_PROVIDER_ID)?.id,
		MISTRAL_PROVIDER_ID,
	);
});

test("keeps the budget when the plan endpoint fails", async () => {
	const adapter = adapterForProvider(MISTRAL_PROVIDER_ID);
	assert.ok(adapter);
	const original = globalThis.fetch;
	globalThis.fetch = async (input) =>
		String(input) === MISTRAL_SUBSCRIPTION_URL
			? jsonResponse({ error: "unavailable" }, 500)
			: jsonResponse(FIXTURE_BUDGET);
	try {
		const report = await queryProviderUsage(
			adapter,
			mistralAuth(),
			new AbortController().signal,
			5_000,
		);
		assert.deepEqual(
			report.metrics.map((metric) => metric.id),
			["payg"],
		);
		assert.equal(report.buckets.length, 2);
	} finally {
		globalThis.fetch = original;
	}
});

test("reports a missing usage permission as unsupported", async () => {
	const adapter = adapterForProvider(MISTRAL_PROVIDER_ID);
	assert.ok(adapter);
	const original = globalThis.fetch;
	globalThis.fetch = async (input) =>
		String(input) === MISTRAL_SUBSCRIPTION_URL
			? jsonResponse(FIXTURE_SUBSCRIPTION)
			: jsonResponse({ detail: "forbidden" }, 403);
	try {
		await assert.rejects(
			queryProviderUsage(
				adapter,
				mistralAuth(),
				new AbortController().signal,
				5_000,
			),
			(error: Error) => {
				assert.ok(error instanceof UsageUnsupportedError);
				assert.match(error.message, /see_org_inference_usage/u);
				return true;
			},
		);
	} finally {
		globalThis.fetch = original;
	}
});

test("surfaces a failing budget endpoint as an error", async () => {
	const adapter = adapterForProvider(MISTRAL_PROVIDER_ID);
	assert.ok(adapter);
	const original = globalThis.fetch;
	globalThis.fetch = async (input) =>
		String(input) === MISTRAL_SUBSCRIPTION_URL
			? jsonResponse(FIXTURE_SUBSCRIPTION)
			: jsonResponse({ error: "unavailable" }, 500);
	try {
		await assert.rejects(
			queryProviderUsage(
				adapter,
				mistralAuth(),
				new AbortController().signal,
				5_000,
			),
			(error: Error) => {
				assert.equal(error instanceof UsageUnsupportedError, false);
				assert.match(error.message, /Mistral budget endpoint returned 500/u);
				return true;
			},
		);
	} finally {
		globalThis.fetch = original;
	}
});

function mistralAuth(): ResolvedUsageAuth {
	return {
		actualProviderId: MISTRAL_PROVIDER_ID,
		headers: { Authorization: "Bearer fixture-token" },
		fingerprint: "fp",
		secrets: ["fixture-token"],
		model: { provider: MISTRAL_PROVIDER_ID, id: "mistral-large-4" },
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
