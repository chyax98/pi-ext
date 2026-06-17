import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MANAGED_AGENT_PROMPT_TEMPLATE_DIR = path.resolve(EXTENSION_DIR, "..", "..", "prompts");

const SYSTEM_PROMPT_MARKER = "<!-- pi-subagents-managed-agent-system-prompt -->";

export const MANAGED_AGENT_SYSTEM_PROMPT = `${SYSTEM_PROMPT_MARKER}
## Managed child agents

This Pi session has the managed-agent extension loaded. Use these tools when delegation or workflow execution helps:

- Use \`agent_roles\` to inspect available child-agent roles.
- Use \`agent_models\` to inspect available child-agent models before setting \`agent_start\` \`runtime.model\`; prefer canonical \`provider/model\` ids.
- Use \`agent_start\` to start managed child Agent runs. Default/omitted placement is foreground blocking wait; prefer it whenever your next step depends on child output.
- \`agent_start\` accepts only top-level \`agents\`, \`placement\`, \`wait\`, \`concurrency\`, \`isolation\`, and \`output\`; put timeout/model overrides inside each \`agents[].runtime\`, not as top-level \`runtime\`.
- Multi-agent \`agent_start\` must use one shared context kind. Do not mix \`context: "fresh"\` and \`context: "fork"\` in one call; split into separate \`agent_start\` calls when contexts differ.
- Parallel scouts often default to writing \`context.md\`. When starting multiple \`scout\` agents in the same \`cwd\`, set top-level \`output: { disable: true }\` unless you are deliberately using distinct isolated worktrees; otherwise their default output paths collide.
- Use \`placement: "background"\` or \`wait: "none"\` only when the child can run while you do independent work, or when the user explicitly asks to background/detach.
- After starting a background run, do not loop, sleep, or repeatedly call \`agent_status\` just to wait. Continue independent work, or end your turn and let Pi deliver the completion follow-up.
- Use \`agent_status\` to inspect background/completed child Agent runs only when needed: user asks, a completion arrives, a run looks blocked/stale, or you need child-specific failure forensics. Pass \`index\` for child details.
- Treat root \`partial\` as usable but not fully green: inspect failed/warning children by index and use the repair command shown by \`agent_status({ id, index })\`.
- Use \`agent_send\` to answer blockers, continue/revive a child run, or send follow-up context.
- Use \`agent_stop\` only for a reasoned soft stop.
- Use \`workflow_list\`, \`workflow_show\`, \`workflow_start\`, \`workflow_status\`, \`workflow_send\`, and \`workflow_stop\` for saved workflow SOPs.

Use only the managed-agent and workflow tools listed above for delegation and SOP execution.

Default role choice:
- \`scout\`: read-only reconnaissance and context gathering.
- \`planner\`: plan only, no code changes.
- \`worker\`: implementation with edits.
- \`reviewer\`: independent review/validation.
- \`delegate\`: lightweight general-purpose child.

Prefer ordinary file artifacts and normal file reading over special output tools when a run returns output paths.`;

export function appendManagedAgentSystemPrompt(systemPrompt: string): string {
	if (systemPrompt.includes(SYSTEM_PROMPT_MARKER)) return systemPrompt;
	return `${systemPrompt.trimEnd()}\n\n${MANAGED_AGENT_SYSTEM_PROMPT}`;
}

export function registerManagedAgentPromptSupport(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: appendManagedAgentSystemPrompt(event.systemPrompt),
	}));
}
