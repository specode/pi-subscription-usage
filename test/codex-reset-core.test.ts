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
				expires_at: "2026-09-02T00:00:00Z",
			},
			{
				id: "earlier",
				status: "available",
				reset_type: "codex_rate_limits",
				expires_at: "2026-09-01T00:00:00Z",
			},
		],
	});
	assert.equal(result.availableCount, 2);
	assert.deepEqual(
		result.options.map((option) => option.creditId),
		["earlier", "later"],
	);
});

test("falls back to a generic reset when the API omits credit details", () => {
	const result = normalizeCodexResetCreditsPayload({ available_count: 1 });
	assert.equal(result.options.length, 1);
	assert.equal(result.options[0]?.creditId, undefined);
});

test("accepts only known idempotent consume outcomes", () => {
	assert.deepEqual(parseCodexResetOutcome({ code: "reset", windows_reset: 2 }), {
		code: "reset",
		windowsReset: 2,
	});
	assert.throws(() => parseCodexResetOutcome({ code: "unknown" }));
});
