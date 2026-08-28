import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_USAGE_CONFIG,
	parseUsageConfig,
	resolveUsageConfig,
} from "../src/config-core.ts";

test("uses remaining as the default display mode", () => {
	assert.equal(DEFAULT_USAGE_CONFIG.displayMode, "remaining");
	assert.deepEqual(parseUsageConfig({}), {});
});

test("lets project configuration override global display mode", () => {
	assert.deepEqual(
		resolveUsageConfig(
			parseUsageConfig({ displayMode: "used" }),
			parseUsageConfig({ displayMode: "remaining" }),
		),
		{ displayMode: "remaining" },
	);
	assert.deepEqual(
		resolveUsageConfig(parseUsageConfig({ displayMode: "used" })),
		{ displayMode: "used" },
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

test("rejects invalid usage configuration", () => {
	assert.match(parseUsageConfig([]).warning ?? "", /JSON object/u);
	assert.match(
		parseUsageConfig({ displayMode: "total" }).warning ?? "",
		/displayMode/u,
	);
});
