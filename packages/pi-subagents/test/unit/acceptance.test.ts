import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	evaluateAcceptance,
	formatAcceptancePrompt,
	parseAcceptanceReport,
	resolveEffectiveAcceptance,
	stripAcceptanceReport,
	validateAcceptanceInput,
} from "../../src/runs/shared/acceptance.ts";

describe("acceptance no-op compatibility", () => {
	it("resolves acceptance to disabled no-op", async () => {
		const acceptance = resolveEffectiveAcceptance({ agentName: "worker", task: "edit file" });
		assert.equal(acceptance.level, "none");
		assert.equal(formatAcceptancePrompt(acceptance), "");

		const ledger = await evaluateAcceptance({ acceptance, output: "child output", cwd: process.cwd() });
		assert.equal(ledger.status, "not-required");
		assert.deepEqual(ledger.runtimeChecks, []);
		assert.deepEqual(ledger.verifyRuns, []);
	});

	it("does not parse or strip child output", () => {
		assert.deepEqual(parseAcceptanceReport("anything"), {});
		assert.equal(stripAcceptanceReport("child output\n```json\n{}\n```"), "child output\n```json\n{}\n```");
	});

	it("ignores legacy acceptance config shapes", () => {
		assert.deepEqual(validateAcceptanceInput({ level: "bogus" }), []);
		assert.deepEqual(validateAcceptanceInput({ criteria: "bad" }), []);
	});
});
