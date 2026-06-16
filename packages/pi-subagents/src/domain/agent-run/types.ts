export type AgentRunStatus = "pending" | "starting" | "running" | "blocked" | "paused" | "completed" | "failed" | "cancelled";

export type AgentRunAttachment = "foreground" | "background" | "detached";

export type AgentRoleScope = "user" | "project" | "both";

export type AgentRunWaitMode = "all" | "first-result" | "first-blocker" | "none";

export type AgentSendPurpose = "question" | "answer" | "add-context" | "change-task" | "follow-up";

export interface ContextPolicy {
	kind: "fresh" | "fork";
	reads?: string[];
	promptContext?: string;
}

export interface AuthorityPolicy {
	tools?: string[];
	extensions?: string[];
	skills?: string[] | boolean;
	canDelegate?: boolean;
	maxDelegationDepth?: number;
	writeAccess?: "none" | "workspace" | "worktree";
	networkAccess?: "none" | "docs" | "open";
}

export interface AcceptanceContract {
	criteria?: Array<string | { id: string; must: string; severity?: "required" | "recommended" }>;
	evidence?: string[];
	verify?: Array<{ id: string; command: string; timeoutMs?: number; cwd?: string; allowFailure?: boolean }>;
	review?: false | { agent?: string; focus?: string; required?: boolean };
	stopRules?: string[];
}

export type IsolationPolicy =
	| { kind: "shared-workspace" }
	| { kind: "git-worktree"; cleanup?: "keep" | "delete-on-success" | "delete-always" };

export interface RuntimePolicy {
	backend?: "pi-cli-spawn" | "pi-sdk-experimental" | "remote";
	model?: string;
	thinking?: string;
	timeoutMs?: number;
	timeoutMinutes?: number;
}

export interface OutputPolicy {
	path?: string;
	mode?: "inline" | "file-only";
	disable?: boolean;
}

export interface AgentStartSpec {
	role: string;
	task: string;
	label?: string;
	cwd?: string;
	context?: "fresh" | "fork" | ContextPolicy;
	authority?: AuthorityPolicy;
	acceptance?: AcceptanceContract | false;
	runtime?: RuntimePolicy;
}

export interface AgentRunHandle {
	id: string;
	role: string;
	status: AgentRunStatus;
	attachment: AgentRunAttachment;
	manifestFile: string;
	outputFile: string;
	sessionFile?: string;
	eventsFile: string;
}
