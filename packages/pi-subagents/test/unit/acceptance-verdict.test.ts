import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAcceptanceVerdict } from "../../src/runs/shared/acceptance-verdict.ts";
import type { AcceptanceLedger } from "../../src/shared/types.ts";

function ledger(status: AcceptanceLedger["status"]): AcceptanceLedger {
	return {
		status,
		explicit: true,
		effectiveAcceptance: { level: "none", criteria: [], evidence: [], verify: [], stopRules: [], review: false },
		inferredReason: [],
		criteria: [],
		runtimeChecks: [],
		verifyRuns: [],
	};
}

describe("acceptance verdict", () => {
	it("does not warn or block when acceptance is not required", () => {
		const verdict = resolveAcceptanceVerdict({ agentName: "worker", task: "Implement fix", exitCode: 0, output: "done", acceptance: ledger("not-required") });
		assert.equal(verdict.verdict, "ok");
		assert.deepEqual(verdict.issues, []);
	});

	it("preserves child process failures", () => {
		const verdict = resolveAcceptanceVerdict({ agentName: "worker", task: "Implement fix", exitCode: 1, output: "failed", acceptance: ledger("not-required") });
		assert.equal(verdict.verdict, "blocking");
		assert.deepEqual(verdict.issues, []);
	});
});
