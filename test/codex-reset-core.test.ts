import assert from "node:assert/strict";
import test from "node:test";
import {
	CODEX_RESET_CONFIRMATION_OPTIONS,
	isCodexResetConfirmed,
	normalizeCodexResetCreditsPayload,
	parseCodexResetOutcome,
} from "../src/codex-reset-core.ts";

test("reset confirmation defaults to cancel and requires an exact opt-in", () => {
	assert.deepEqual(CODEX_RESET_CONFIRMATION_OPTIONS, [
		"Cancel (Default)",
		"Redeem 1 Reset (Irreversible)",
	]);
	assert.equal(isCodexResetConfirmed(undefined), false);
	assert.equal(
		isCodexResetConfirmed(CODEX_RESET_CONFIRMATION_OPTIONS[0]),
		false,
	);
	assert.equal(isCodexResetConfirmed(CODEX_RESET_CONFIRMATION_OPTIONS[1]), true);
});

test("normalizes available Codex reset credits in expiration order", () => {
	const result = normalizeCodexResetCreditsPayload({
		available_count: 2,
		credits: [
			{
				id: "later",
				status: "available",
				reset_type: "codex_rate_limits",
				is_supported_by_plan: true,
				expires_at: "2026-09-02T00:00:00Z",
			},
			{
				id: "earlier",
				status: "available",
				reset_type: "codex_rate_limits",
				is_supported_by_plan: true,
				expires_at: "2026-09-01T00:00:00Z",
			},
		],
	}, { now: Date.parse("2026-08-01T00:00:00Z") });
	assert.equal(result.availableCount, 2);
	assert.deepEqual(
		result.options.map((option) => option.creditId),
		["earlier", "later"],
	);
});

test("never offers a server-chosen reset from a summary count alone", () => {
	for (const payload of [
		{ available_count: 1 },
		{ available_count: 1, credits: [{ id: "x", status: "available", reset_type: "other" }] },
	]) {
		const result = normalizeCodexResetCreditsPayload(payload);
		assert.equal(result.availableCount, 0);
		assert.deepEqual(result.options, []);
	}
});

test("applies strict ticket boundaries", () => {
	const now = Date.parse("2026-08-01T00:00:00Z");
	const ticket = (id: string, extra: object = {}) => ({
		id,
		status: "available",
		reset_type: "codex_rate_limits",
		is_supported_by_plan: true,
		...extra,
	});
	const ids = (payload: Record<string, unknown>) =>
		normalizeCodexResetCreditsPayload(payload, { now }).options.map((option) => option.creditId);
	// Plan support must be explicit, not merely absent.
	assert.deepEqual(ids({ available_count: 1, credits: [{ ...ticket("a"), is_supported_by_plan: undefined }] }), []);
	// A ticket expiring exactly now is already unusable.
	assert.deepEqual(ids({ available_count: 1, credits: [ticket("a", { expires_at: new Date(now).toISOString() })] }), []);
	// The server's summary caps the offered details, soonest expiry first.
	assert.deepEqual(ids({ available_count: 1, credits: [
		ticket("later", { expires_at: "2026-08-03T00:00:00Z" }),
		ticket("sooner", { expires_at: "2026-08-02T00:00:00Z" }),
	] }), ["sooner"]);
	const many = Array.from({ length: 40 }, (_, index) => ticket(`t${index}`));
	assert.equal(normalizeCodexResetCreditsPayload({ available_count: 40, credits: many }, { now }).availableCount, 32);
});

test("accepts only known idempotent consume outcomes", () => {
	assert.deepEqual(parseCodexResetOutcome({ code: "reset", windows_reset: 2 }), {
		code: "reset",
		windowsReset: 2,
	});
	assert.throws(() => parseCodexResetOutcome({ code: "unknown" }));
});
