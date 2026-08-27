import assert from "node:assert/strict";
import test from "node:test";
import {
	redactUsageError,
	sanitizeDisplayText,
	UsageCache,
} from "../src/core.ts";
import type { UsageReport } from "../src/types.ts";

const report: UsageReport = {
	providerId: "test",
	providerName: "Test",
	capturedAt: 1,
	source: "test",
	semantics: { kind: "consumer-subscription", label: "test" },
	buckets: [],
	metrics: [],
};

test("cache is isolated by provider and credential fingerprint", () => {
	const cache = new UsageCache(100, 4);
	cache.set("a", "one", report, 1_000);
	assert.equal(cache.get("a", "one", 1_050), report);
	assert.equal(cache.get("a", "two", 1_050), undefined);
	assert.equal(cache.get("b", "one", 1_050), undefined);
	assert.equal(cache.get("a", "one", 1_100), undefined);
});

test("sanitizes terminal controls and redacts secrets", () => {
	assert.equal(
		sanitizeDisplayText("ok\x1b[31m red\x1b[0m\nnext"),
		"ok red next",
	);
	const secret = "token-value";
	const redacted = redactUsageError(`Bearer ${secret}; raw=${secret}`, [secret]);
	assert.equal(redacted.includes(secret), false);
	assert.match(redacted, /<redacted>/u);
});
