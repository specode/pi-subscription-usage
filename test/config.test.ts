import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_USAGE_CONFIG,
	parseUsageConfig,
	resolveUsageConfig,
} from "../src/config-core.ts";

test("uses remaining as the default display mode", () => {
	assert.equal(DEFAULT_USAGE_CONFIG.displayMode, "remaining");
	assert.equal(DEFAULT_USAGE_CONFIG.showAllProviders, false);
	assert.equal(DEFAULT_USAGE_CONFIG.offerResetCredits, true);
	assert.deepEqual(parseUsageConfig({}), {});
});

test("lets project configuration override global display mode", () => {
	assert.deepEqual(
		resolveUsageConfig(
			parseUsageConfig({ displayMode: "used" }),
			parseUsageConfig({ displayMode: "remaining" }),
		),
		{ displayMode: "remaining", showAllProviders: false, offerResetCredits: true },
	);
	assert.deepEqual(
		resolveUsageConfig(parseUsageConfig({ displayMode: "used" })),
		{ displayMode: "used", showAllProviders: false, offerResetCredits: true },
	);
});

test("accepts remaining and used display modes", () => {
	assert.deepEqual(parseUsageConfig({ displayMode: "remaining" }), {
		displayMode: "remaining",
	});
	assert.deepEqual(parseUsageConfig({ displayMode: "used" }), {
		displayMode: "used",
	});
});

test("shows only the active provider unless showAllProviders is on", () => {
	assert.equal(resolveUsageConfig().showAllProviders, false);
	assert.equal(
		resolveUsageConfig(parseUsageConfig({ showAllProviders: true }))
			.showAllProviders,
		true,
	);
	assert.equal(
		resolveUsageConfig(
			parseUsageConfig({ showAllProviders: true }),
			parseUsageConfig({ showAllProviders: false }),
		).showAllProviders,
		false,
	);
	assert.deepEqual(parseUsageConfig({ showAllProviders: true }), {
		showAllProviders: true,
	});
});

test("rejects invalid usage configuration", () => {
	assert.match(parseUsageConfig([]).warning ?? "", /JSON object/u);
	assert.match(
		parseUsageConfig({ displayMode: "total" }).warning ?? "",
		/displayMode/u,
	);
	assert.match(
		parseUsageConfig({ showAllProviders: "yes" }).warning ?? "",
		/showAllProviders must be true or false/u,
	);
	assert.match(
		parseUsageConfig({ offerResetCredits: "no" }).warning ?? "",
		/offerResetCredits must be true or false/u,
	);
});

test("offers reset credits unless offerResetCredits is off", () => {
	assert.equal(resolveUsageConfig().offerResetCredits, true);
	assert.equal(
		resolveUsageConfig(parseUsageConfig({ offerResetCredits: false }))
			.offerResetCredits,
		false,
	);
	assert.equal(
		resolveUsageConfig(
			parseUsageConfig({ offerResetCredits: false }),
			parseUsageConfig({ offerResetCredits: true }),
		).offerResetCredits,
		true,
	);
});
