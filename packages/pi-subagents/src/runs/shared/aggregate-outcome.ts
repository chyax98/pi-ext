import type { AggregateOutcome, ChildIssue, ChildVerdict } from "../../shared/types.ts";
import { classifyTaskIntent } from "./task-classification.ts";

export type AggregatePolicy = "all-required" | "best-effort";

interface AggregateResultLike {
	exitCode?: number | null;
	success?: boolean;
	interrupted?: boolean;
	detached?: boolean;
	issues?: ChildIssue[];
	verdict?: ChildVerdict;
}

function resultSucceeded(result: AggregateResultLike): boolean {
	if (typeof result.success === "boolean") return result.success;
	return result.exitCode === 0;
}

function resultPaused(result: AggregateResultLike): boolean {
	return Boolean(result.interrupted || result.detached);
}

function resultHasWarning(result: AggregateResultLike): boolean {
	return result.verdict === "warning" || Boolean(result.issues?.some((issue) => issue.severity === "warning"));
}

export function inferAggregatePolicy(input: { agents: string[]; tasks?: string[] }): AggregatePolicy {
	if (input.agents.length === 0) return "all-required";
	const intents = input.agents.map((agentName, index) => classifyTaskIntent({ agentName, task: input.tasks?.[index] }));
	return intents.every((intent) => intent === "read-only") ? "best-effort" : "all-required";
}

export function resolveAggregateOutcome(input: { results: AggregateResultLike[]; policy: AggregatePolicy }): AggregateOutcome {
	const total = input.results.length;
	const usableIndexes: number[] = [];
	const failedIndexes: number[] = [];
	const warningIndexes: number[] = [];
	let paused = false;

	input.results.forEach((result, index) => {
		if (resultPaused(result)) {
			paused = true;
			return;
		}
		if (!resultSucceeded(result)) {
			failedIndexes.push(index);
			return;
		}
		usableIndexes.push(index);
		if (resultHasWarning(result)) warningIndexes.push(index);
	});

	const usable = usableIndexes.length;
	const failed = failedIndexes.length;
	const warnings = warningIndexes.length;
	const counts = `${usable}/${total} usable${failed ? `; ${failed} failed` : ""}${warnings ? `; ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`;

	if (paused) return { status: "paused", usable, failed, warnings, total, usableIndexes, failedIndexes, warningIndexes, message: `Paused with ${counts}.` };
	if (total === 0) return { status: "failed", usable, failed, warnings, total, usableIndexes, failedIndexes, warningIndexes, message: "Failed: no child run was launched." };

	if (input.policy === "best-effort") {
		if (usable > 0 && (failed > 0 || warnings > 0)) return { status: "partial", usable, failed, warnings, total, usableIndexes, failedIndexes, warningIndexes, message: `Partial success: ${counts}. Usable results preserved.` };
		if (usable > 0) return { status: "complete", usable, failed, warnings, total, usableIndexes, failedIndexes, warningIndexes, message: `${usable}/${total} usable.` };
		return { status: "failed", usable, failed, warnings, total, usableIndexes, failedIndexes, warningIndexes, message: "Failed: no child run produced usable output." };
	}

	if (failed > 0 || usable !== total) return { status: "failed", usable, failed: failed || total - usable, warnings, total, usableIndexes, failedIndexes, warningIndexes, message: `Failed: ${failed || total - usable} required child run(s) failed.` };
	if (warnings > 0) return { status: "partial", usable, failed, warnings, total, usableIndexes, failedIndexes, warningIndexes, message: `Completed with warnings: ${counts}.` };
	return { status: "complete", usable, failed, warnings, total, usableIndexes, failedIndexes, warningIndexes, message: `${usable}/${total} usable.` };
}
