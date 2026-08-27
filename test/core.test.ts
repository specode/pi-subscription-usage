import assert from "node:assert/strict";
import test from "node:test";
import {
	awaitWithDeadline,
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

test("does not start a deadline operation after cancellation", async () => {
	const controller = new AbortController();
	controller.abort();
	let started = false;
	await assert.rejects(
		awaitWithDeadline(
			async () => {
				started = true;
				throw new Error("orphaned operation");
			},
			controller.signal,
			100,
			"running a test operation",
		),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
	assert.equal(started, false);
});

test("observes an operation that rejects after its deadline", async () => {
	let rejectOperation: ((error: Error) => void) | undefined;
	const operation = new Promise<never>((_resolve, reject) => {
		rejectOperation = reject;
	});
	await assert.rejects(
		awaitWithDeadline(
			() => operation,
			new AbortController().signal,
			1,
			"running a test operation",
		),
		(error: unknown) => error instanceof Error && error.name === "TimeoutError",
	);
	rejectOperation?.(new Error("late failure"));
	await new Promise((resolve) => setImmediate(resolve));
});
