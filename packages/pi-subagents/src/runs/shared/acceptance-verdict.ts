import type { AcceptanceLedger, ArtifactPaths, ChildIssue, ChildVerdict } from "../../shared/types.ts";

export interface AcceptanceVerdictInput {
	agentName: string;
	task?: string;
	exitCode: number | null | undefined;
	output?: string;
	finalOutput?: string;
	savedOutputPath?: string;
	artifactPaths?: ArtifactPaths;
	acceptance?: AcceptanceLedger;
	observedMutationAttempt?: boolean;
}

export interface AcceptanceVerdict {
	verdict: ChildVerdict;
	issues: ChildIssue[];
}

export function resolveAcceptanceVerdict(input: AcceptanceVerdictInput): AcceptanceVerdict {
	return { verdict: input.exitCode === 0 ? "ok" : "blocking", issues: [] };
}
