import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_SUBAGENT_TIMEOUT_MS,
	MIN_SUBAGENT_TIMEOUT_MS,
	requestedSubagentTimeoutMs,
	resolveSubagentTimeoutMs,
} from "../../src/shared/types.ts";

describe("subagent timeout policy", () => {
	it("defaults to a long timeout", () => {
		assert.equal(DEFAULT_SUBAGENT_TIMEOUT_MS, 30 * 60_000);
		assert.equal(resolveSubagentTimeoutMs(undefined), DEFAULT_SUBAGENT_TIMEOUT_MS);
	});

	it("clamps short model-provided timeouts to the minimum", () => {
		assert.equal(MIN_SUBAGENT_TIMEOUT_MS, 10 * 60_000);
		assert.equal(resolveSubagentTimeoutMs(60_000), MIN_SUBAGENT_TIMEOUT_MS);
		assert.equal(resolveSubagentTimeoutMs(5 * 60_000), MIN_SUBAGENT_TIMEOUT_MS);
		assert.equal(resolveSubagentTimeoutMs(10 * 60_000 - 1), MIN_SUBAGENT_TIMEOUT_MS);
	});

	it("keeps explicit longer timeouts", () => {
		assert.equal(resolveSubagentTimeoutMs(10 * 60_000), 10 * 60_000);
		assert.equal(resolveSubagentTimeoutMs(45 * 60_000 + 123), 45 * 60_000 + 123);
	});

	it("treats invalid timeouts as default", () => {
		assert.equal(resolveSubagentTimeoutMs(0), DEFAULT_SUBAGENT_TIMEOUT_MS);
		assert.equal(resolveSubagentTimeoutMs(-1), DEFAULT_SUBAGENT_TIMEOUT_MS);
		assert.equal(resolveSubagentTimeoutMs(Number.NaN), DEFAULT_SUBAGENT_TIMEOUT_MS);
	});

	it("accepts preferred minute-level timeout input", () => {
		assert.equal(requestedSubagentTimeoutMs({ timeoutMinutes: 3 }), 3 * 60_000);
		assert.equal(resolveSubagentTimeoutMs(requestedSubagentTimeoutMs({ timeoutMinutes: 3 })), MIN_SUBAGENT_TIMEOUT_MS);
		assert.equal(resolveSubagentTimeoutMs(requestedSubagentTimeoutMs({ timeoutMinutes: 12 })), 12 * 60_000);
	});
});
