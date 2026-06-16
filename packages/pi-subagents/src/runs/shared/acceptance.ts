import type {
	AcceptanceConfig,
	AcceptanceInput,
	AcceptanceLedger,
	AcceptanceReport,
	ResolvedAcceptanceConfig,
	SingleResult,
	SubagentRunMode,
} from "../../shared/types.ts";

export function normalizeAcceptanceInput(input: AcceptanceInput | undefined): AcceptanceConfig {
	if (input === undefined || input === false || input === "auto") return { level: "none" };
	if (typeof input === "string") return { level: "none" };
	return { level: "none", reason: input.reason };
}

export function validateAcceptanceInput(_input: unknown, _pathLabel = "acceptance"): string[] {
	return [];
}

export function resolveEffectiveAcceptance(input: {
	explicit?: AcceptanceInput;
	agentName?: string;
	task?: string;
	mode?: SubagentRunMode;
	async?: boolean;
	dynamic?: boolean;
	dynamicGroup?: boolean;
}): ResolvedAcceptanceConfig {
	return {
		level: "none",
		explicit: input.explicit !== undefined,
		inferredReason: [],
		criteria: [],
		evidence: [],
		verify: [],
		review: false,
		stopRules: [],
	};
}

export function formatAcceptancePrompt(_acceptance: ResolvedAcceptanceConfig): string {
	return "";
}

export function parseAcceptanceReport(_output: string): { report?: AcceptanceReport; error?: string } {
	return {};
}

export function stripAcceptanceReport(output: string): string {
	return output;
}

function uniqueStrings(items: Array<string | undefined>): string[] {
	return [...new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item)))];
}

export function aggregateAcceptanceReport(input: {
	results: Array<Pick<SingleResult, "agent" | "acceptance" | "error" | "exitCode">>;
	notes?: string;
}): AcceptanceReport {
	const childReports = input.results.map((result) => result.acceptance?.childReport).filter((report): report is AcceptanceReport => Boolean(report));
	const failedChildren = input.results.filter((result) => result.exitCode !== 0);
	return {
		criteriaSatisfied: input.results.map((result, index) => ({
			id: `child-${index + 1}`,
			status: result.exitCode === 0 ? "satisfied" : "not-satisfied",
			evidence: `${result.agent}: exit ${result.exitCode ?? "unknown"}${result.error ? ` (${result.error})` : ""}`,
		})),
		changedFiles: uniqueStrings(childReports.flatMap((report) => report.changedFiles ?? [])),
		commandsRun: childReports.flatMap((report) => report.commandsRun ?? []),
		validationOutput: uniqueStrings(childReports.flatMap((report) => report.validationOutput ?? [])),
		residualRisks: uniqueStrings([
			...childReports.flatMap((report) => report.residualRisks ?? []),
			...failedChildren.map((result) => `${result.agent}: ${result.error ?? "child failed"}`),
		]),
		reviewFindings: uniqueStrings(childReports.flatMap((report) => report.reviewFindings ?? [])),
		manualNotes: input.notes ?? `Aggregated output metadata from ${input.results.length} child run(s).`,
		notes: input.notes,
	};
}

export async function evaluateAcceptance(input: {
	acceptance: ResolvedAcceptanceConfig;
	output: string;
	cwd: string;
	report?: AcceptanceReport;
}): Promise<AcceptanceLedger> {
	return {
		status: "not-required",
		explicit: input.acceptance.explicit,
		effectiveAcceptance: resolveEffectiveAcceptance({ explicit: input.acceptance.explicit ? "none" : undefined }),
		inferredReason: [],
		criteria: [],
		runtimeChecks: [],
		verifyRuns: [],
		...(input.report ? { childReport: input.report } : {}),
	};
}

export function acceptanceFailureMessage(_ledger: AcceptanceLedger): string | undefined {
	return undefined;
}
