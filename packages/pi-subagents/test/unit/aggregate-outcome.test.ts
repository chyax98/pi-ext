import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferAggregatePolicy, resolveAggregateOutcome } from "../../src/runs/shared/aggregate-outcome.ts";
import type { SingleResult } from "../../src/shared/types.ts";

function result(agent: string, exitCode: number): SingleResult {
	return {
		agent,
		task: `${agent} task`,
		exitCode,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

describe("aggregate outcome policy", () => {
	it("uses best-effort for read-only scout/reviewer fanout", () => {
		assert.equal(inferAggregatePolicy({ agents: ["scout", "scout", "reviewer"], tasks: ["Inspect docs", "Summarize findings", "Review only"] }), "best-effort");
	});

	it("uses all-required for workers or write-intent tasks", () => {
		assert.equal(inferAggregatePolicy({ agents: ["worker", "scout"], tasks: ["Inspect", "Summarize"] }), "all-required");
		assert.equal(inferAggregatePolicy({ agents: ["scout", "scout"], tasks: ["Implement fix", "Inspect"] }), "all-required");
	});

	it("does not expose internal policy in aggregate outcome", () => {
		const outcome = resolveAggregateOutcome({ policy: "best-effort", results: [result("scout", 0)] });
		assert.equal("policy" in outcome, false);
	});

	it("treats one failed scout as partial usable under best-effort", () => {
		const outcome = resolveAggregateOutcome({ policy: "best-effort", results: [result("scout", 0), result("scout", 1), result("scout", 0)] });
		assert.equal(outcome.status, "partial");
		assert.equal(outcome.usable, 2);
		assert.equal(outcome.failed, 1);
		assert.deepEqual(outcome.usableIndexes, [0, 2]);
		assert.deepEqual(outcome.failedIndexes, [1]);
		assert.match(outcome.message ?? "", /Usable results preserved/);
	});

	it("fails best-effort only when no child succeeded", () => {
		const outcome = resolveAggregateOutcome({ policy: "best-effort", results: [result("scout", 1), result("scout", 1)] });
		assert.equal(outcome.status, "failed");
		assert.match(outcome.message ?? "", /no child run produced usable output/);
	});

	it("keeps all-required strict", () => {
		const outcome = resolveAggregateOutcome({ policy: "all-required", results: [result("worker", 0), result("worker", 1)] });
		assert.equal(outcome.status, "failed");
		assert.match(outcome.message ?? "", /required child/);
	});

	it("treats warning children as usable partial", () => {
		const outcome = resolveAggregateOutcome({ policy: "best-effort", results: [result("scout", 0), { ...result("scout", 0), verdict: "warning", issues: [{ severity: "warning", source: "acceptance", message: "Acceptance warning" }] }] });
		assert.equal(outcome.status, "partial");
		assert.equal(outcome.usable, 2);
		assert.equal(outcome.warnings, 1);
		assert.deepEqual(outcome.warningIndexes, [1]);
	});

	it("marks paused outcomes before success/failure aggregation", () => {
		const outcome = resolveAggregateOutcome({ policy: "best-effort", results: [{ success: true }, { success: false, interrupted: true }] });
		assert.equal(outcome.status, "paused");
	});
});
