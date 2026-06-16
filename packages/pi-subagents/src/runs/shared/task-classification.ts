export type LaneKind = "read" | "plan" | "review" | "write" | "unknown";
export type TaskIntent = "read-only" | "write-capable" | "neutral";

const READ_AGENTS = /\b(?:scout|context-builder|researcher|analyst)\b/i;
const PLAN_AGENTS = /\b(?:planner)\b/i;
const REVIEW_AGENTS = /\b(?:reviewer)\b/i;
const WRITE_CAPABLE_AGENTS = /\b(?:worker)\b/i;

const READ_ONLY_TASK = /\b(?:read[- ]only|review[- ]only|do not edit|don't edit|no edits|without edits|inspect|summari[sz]e|analy[sz]e|research|audit)\b/i;
const PLAN_ONLY_TASK = /\b(?:plan[- ]only|planning[- ]only|write (?:a )?plan|create (?:a )?plan|draft (?:a )?plan|proposal|design doc|prd|roadmap)\b/i;
const REVIEW_ONLY_TASK = /\b(?:review[- ]only|code review|architecture review|audit findings|no implementation)\b/i;
const WRITE_INTENT_TASK = /\b(?:fix|implement|update|write|edit|modify|migrate|release|security|delete|remove|refactor|commit|create|add|replace|patch)\b/i;
const RISKY_TASK = /\b(?:release|migration|migrate|security|data[- ]loss|destructive|post-review|fix pass)\b/i;

export function isReadOnlyAgent(agentName: string): boolean {
	return READ_AGENTS.test(agentName) || REVIEW_AGENTS.test(agentName);
}

export function isPlanningAgent(agentName: string): boolean {
	return PLAN_AGENTS.test(agentName);
}

export function isReviewAgent(agentName: string): boolean {
	return REVIEW_AGENTS.test(agentName);
}

export function isWriteCapableAgent(agentName: string): boolean {
	return WRITE_CAPABLE_AGENTS.test(agentName);
}

export function isReadOnlyTask(task: string | undefined): boolean {
	return READ_ONLY_TASK.test(task ?? "") || REVIEW_ONLY_TASK.test(task ?? "");
}

export function isPlanOnlyTask(task: string | undefined): boolean {
	return PLAN_ONLY_TASK.test(task ?? "");
}

export function hasWriteIntent(task: string | undefined): boolean {
	return WRITE_INTENT_TASK.test(task ?? "");
}

export function isRiskyTask(task: string | undefined): boolean {
	return RISKY_TASK.test(task ?? "");
}

export function classifyLaneKind(input: { agentName: string; task?: string }): LaneKind {
	if (isWriteCapableAgent(input.agentName)) return "write";
	if (hasWriteIntent(input.task) && !isReadOnlyTask(input.task) && !isPlanOnlyTask(input.task)) return "write";
	if (isPlanningAgent(input.agentName) || isPlanOnlyTask(input.task)) return "plan";
	if (isReviewAgent(input.agentName) || REVIEW_ONLY_TASK.test(input.task ?? "")) return "review";
	if (READ_AGENTS.test(input.agentName) || isReadOnlyTask(input.task)) return "read";
	return "unknown";
}

export function classifyTaskIntent(input: { agentName: string; task?: string }): TaskIntent {
	const lane = classifyLaneKind(input);
	if (lane === "write") return "write-capable";
	if (lane === "read" || lane === "plan" || lane === "review") return "read-only";
	return "neutral";
}

export function isEvidenceWarningEligible(input: { agentName: string; task?: string }): boolean {
	const lane = classifyLaneKind(input);
	return lane === "read" || lane === "plan" || lane === "review";
}
