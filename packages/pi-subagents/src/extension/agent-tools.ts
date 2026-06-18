import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { renderSubagentResult } from "../tui/render.ts";
import type { AgentConfig, AgentScope } from "../agents/agents.ts";
import type { ChildExtensionPolicy, Details } from "../shared/types.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { toModelInfo, type ModelInfo } from "../shared/model-info.ts";
import { resolveRequestedModel, type ModelResolution } from "../runs/shared/model-resolver.ts";

const Scope = Type.String({ enum: ["user", "project", "both"] });
const Placement = Type.String({ enum: ["foreground", "background"], description: "Runtime attachment. Default is foreground/blocking; use background only when the parent can continue independent work or the user asks to detach." });
const WaitMode = Type.String({ enum: ["all", "none"], description: "Wait policy. Default/all blocks for results. none is a compatibility alias for background; do not use it when the next step depends on child output." });
const OutputMode = Type.String({ enum: ["inline", "file-only"] });

const ContextPolicy = Type.Unsafe({
	anyOf: [
		{ type: "string", enum: ["fresh", "fork"] },
		{
			type: "object",
			properties: {
				kind: { type: "string", enum: ["fresh", "fork"] },
				reads: { type: "array", items: { type: "string" } },
				promptContext: { type: "string" },
			},
			additionalProperties: false,
		},
	],
	description: "Context policy. Use 'fresh' for clean context or 'fork' to branch current Pi session.",
});

const AuthorityPolicy = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	description: "Optional authority overrides supported by this adapter: skills and extensions.",
});

const RuntimePolicy = Type.Object({
	model: Type.Optional(Type.String({ description: "Optional model override." })),
	timeoutMs: Type.Optional(Type.Number({ minimum: 1, description: "Optional timeout in milliseconds." })),
	timeoutMinutes: Type.Optional(Type.Number({ minimum: 1, description: "Optional timeout in minutes." })),
}, { additionalProperties: false, description: "Optional runtime overrides supported by this adapter: model and timeout." });

const IsolationPolicy = Type.Unsafe({
	anyOf: [
		{ type: "string", enum: ["shared-workspace", "git-worktree"] },
		{
			type: "object",
			properties: { kind: { type: "string", enum: ["shared-workspace", "git-worktree"] } },
			required: ["kind"],
			additionalProperties: false,
		},
	],
	description: "Optional isolation policy. git-worktree maps to existing worktree isolation.",
});

const OutputPolicy = Type.Object({
	path: Type.Optional(Type.String({ description: "Output file path relative to cwd or absolute." })),
	mode: Type.Optional(OutputMode),
	disable: Type.Optional(Type.Boolean({ description: "Disable file output." })),
}, { additionalProperties: false, description: "Top-level output policy shared by all agents in this agent_start call." });

const AgentStartSpec = Type.Object({
	role: Type.String({ description: "Managed-agent role name returned by agent_roles." }),
	task: Type.String({ description: "Task for this agent." }),
	cwd: Type.Optional(Type.String()),
	context: Type.Optional(ContextPolicy),
	authority: Type.Optional(AuthorityPolicy),
	runtime: Type.Optional(RuntimePolicy),
	output: Type.Optional(Type.Unsafe({
		...OutputPolicy,
		description: "Compatibility shim only. Prefer top-level agent_start output; identical agents[].output values are promoted, mixed per-agent output is rejected.",
	})),
}, { additionalProperties: false });

const AgentRolesParams = Type.Object({
	role: Type.Optional(Type.String({ description: "Optional role name to inspect." })),
	scope: Type.Optional(Scope),
	includeDisabled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const AgentModelsParams = Type.Object({
	role: Type.Optional(Type.String({ description: "Optional role name to show role context for." })),
}, { additionalProperties: false });

const AgentStartParams = Type.Object({
	agents: Type.Array(AgentStartSpec, { minItems: 1, description: "One or more managed agents to start." }),
	placement: Type.Optional(Placement),
	wait: Type.Optional(WaitMode),
	concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
	isolation: Type.Optional(IsolationPolicy),
	output: Type.Optional(OutputPolicy),
}, { additionalProperties: false });

const AgentStatusParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Agent run id or prefix. Omit to list active runs." })),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Child index for multi-child runs." })),
}, { additionalProperties: false });

const AgentSendParams = Type.Object({
	id: Type.String({ description: "Agent run id or prefix." }),
	input: Type.String({ description: "Input/update/answer to send to the agent run." }),
	purpose: Type.Optional(Type.String({ enum: ["question", "answer", "add-context", "change-task", "follow-up"] })),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Child index for multi-child runs when resuming a specific child." })),
}, { additionalProperties: false });

const AgentStopParams = Type.Object({
	id: Type.String({ description: "Agent run id or prefix." }),
	reason: Type.String({ description: "Why stopping this agent run." }),
}, { additionalProperties: false });

interface AgentToolDeps {
	pi: ExtensionAPI;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[] };
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>> | AgentToolResult<Details>;
}

function textResult(text: string): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], details: { mode: "management", results: [] } };
}

function errorResult(text: string): AgentToolResult<Details> {
	return { ...textResult(text), isError: true };
}

function normalizeScope(scope: unknown): AgentScope {
	return scope === "user" || scope === "project" || scope === "both" ? scope : "both";
}

function contextKind(context: unknown): "fresh" | "fork" | undefined {
	if (context === "fresh" || context === "fork") return context;
	if (context && typeof context === "object" && "kind" in context) {
		const kind = (context as { kind?: unknown }).kind;
		if (kind === "fresh" || kind === "fork") return kind;
	}
	return undefined;
}

function timeoutMinutes(runtime: unknown): number | undefined {
	if (!runtime || typeof runtime !== "object") return undefined;
	const value = (runtime as { timeoutMinutes?: unknown; timeoutMs?: unknown }).timeoutMinutes;
	if (typeof value === "number" && Number.isFinite(value)) return Math.ceil(value);
	const ms = (runtime as { timeoutMs?: unknown }).timeoutMs;
	if (typeof ms === "number" && Number.isFinite(ms)) return Math.ceil(ms / 60_000);
	return undefined;
}

function modelOverride(runtime: unknown): string | undefined {
	if (!runtime || typeof runtime !== "object") return undefined;
	const value = (runtime as { model?: unknown }).model;
	return typeof value === "string" ? value : undefined;
}

function availableModelInfos(ctx: ExtensionContext): ModelInfo[] {
	const registry = (ctx as { modelRegistry?: { getAvailable?: () => Array<{ provider: string; id: string }> } }).modelRegistry;
	return registry?.getAvailable?.().map(toModelInfo) ?? [];
}

function preferredProvider(ctx: ExtensionContext): string | undefined {
	return (ctx as { model?: { provider?: string } }).model?.provider;
}

function formatModelList(models: ModelInfo[]): string {
	return models.length ? models.map((model) => `- ${model.fullId}`).join("\n") : "(none)";
}

function formatAgentModels(models: ModelInfo[], role: AgentConfig | undefined): string {
	const header = role ? `Available models for ${role.name}:` : "Available models:";
	const roleLines = role ? [
		role.model ? `Role default model: ${role.model}` : undefined,
		role.fallbackModels?.length ? `Role fallback models: ${role.fallbackModels.join(", ")}` : undefined,
	].filter((line): line is string => Boolean(line)) : [];
	return [
		header,
		formatModelList(models),
		roleLines.length ? "" : undefined,
		...roleLines,
		"",
		"Use canonical provider/model ids in agent_start agents[].runtime.model.",
		"Bare ids are resolved by exact model id first; provider ties prefer current provider, then a runtime tie-break.",
	].filter((line) => line !== undefined).join("\n");
}

function formatModelResolutionFailure(role: string, resolution: ModelResolution): string {
	if (resolution.ok) return "";
	return [
		`agent_start model for role '${role}' is not available: ${resolution.requested}`,
		resolution.message,
		"Use agent_models({ role }) to inspect available canonical ids.",
	].join("\n");
}

function resolveRuntimeModelForSpec(spec: Record<string, unknown>, ctx: ExtensionContext): ModelResolution {
	const requested = modelOverride(spec.runtime);
	const available = availableModelInfos(ctx);
	if (requested && available.length === 0) return { ok: true, kind: "none", requested, resolved: requested, confidence: "medium", note: "Model registry unavailable; passing requested model through." };
	return resolveRequestedModel({
		requested,
		available,
		preferredProvider: preferredProvider(ctx),
	});
}

const SUPPORTED_RUNTIME_FIELDS = new Set(["model", "timeoutMs", "timeoutMinutes"]);

const SUPPORTED_CONTEXT_FIELDS = new Set(["kind", "reads", "promptContext"]);

function unsupportedContextFields(context: unknown): string[] {
	if (!context || typeof context !== "object" || Array.isArray(context)) return [];
	return Object.keys(context as Record<string, unknown>).filter((key) => !SUPPORTED_CONTEXT_FIELDS.has(key));
}

function runtimeObject(runtime: unknown): Record<string, unknown> | undefined {
	return runtime && typeof runtime === "object" && !Array.isArray(runtime) ? runtime as Record<string, unknown> : undefined;
}

function unsupportedRuntimeFields(runtime: unknown): string[] {
	const obj = runtimeObject(runtime);
	if (!obj) return [];
	return Object.keys(obj).filter((key) => !SUPPORTED_RUNTIME_FIELDS.has(key));
}

function unsupportedIsolationReason(isolation: unknown): string | undefined {
	if (isolation === undefined || isolation === "shared-workspace" || isolation === "git-worktree") return undefined;
	if (isolation && typeof isolation === "object" && !Array.isArray(isolation)) {
		const keys = Object.keys(isolation as Record<string, unknown>);
		const kind = (isolation as { kind?: unknown }).kind;
		if (keys.length === 1 && (kind === "shared-workspace" || kind === "git-worktree")) return undefined;
	}
	return "agent_start isolation supports only 'shared-workspace' or 'git-worktree'.";
}

function outputOverride(output: unknown): { output?: string | boolean; outputMode?: "inline" | "file-only" } {
	if (!output || typeof output !== "object") return {};
	const policy = output as { path?: unknown; mode?: unknown; disable?: unknown };
	return {
		...(policy.disable === true ? { output: false } : typeof policy.path === "string" ? { output: policy.path } : {}),
		...(policy.mode === "inline" || policy.mode === "file-only" ? { outputMode: policy.mode } : {}),
	};
}

function hasOwn(object: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizedOutputPolicy(output: unknown): { path?: string; mode?: "inline" | "file-only"; disable?: true } {
	if (!output || typeof output !== "object" || Array.isArray(output)) return {};
	const policy = output as { path?: unknown; mode?: unknown; disable?: unknown };
	return {
		...(typeof policy.path === "string" ? { path: policy.path } : {}),
		...(policy.mode === "inline" || policy.mode === "file-only" ? { mode: policy.mode } : {}),
		...(policy.disable === true ? { disable: true } : {}),
	};
}

function outputPolicyKey(output: unknown): string {
	const policy = normalizedOutputPolicy(output);
	return JSON.stringify({ path: policy.path, mode: policy.mode, disable: policy.disable });
}

function reconcileOutputPolicy(input: { agents: Array<Record<string, unknown>>; output?: unknown }): { output?: unknown; error?: string } {
	const agentOutputs = input.agents
		.map((spec, index) => ({ index, hasOutput: hasOwn(spec, "output"), output: spec.output }))
		.filter((entry) => entry.hasOutput);
	if (agentOutputs.length === 0) return { output: input.output };
	if (agentOutputs.length !== input.agents.length) {
		return {
			error: "agent_start received agents[].output on only some agents. Per-agent output is not supported; move one shared policy to top-level output or split into separate agent_start calls.",
		};
	}
	const first = agentOutputs[0]!;
	const firstKey = outputPolicyKey(first.output);
	const different = agentOutputs.find((entry) => outputPolicyKey(entry.output) !== firstKey);
	if (different) {
		return {
			error: `agent_start received different agents[].output values at agents[${first.index}] and agents[${different.index}]. Per-agent output is not supported; use one top-level output shared by all agents, or split into separate agent_start calls.`,
		};
	}
	if (input.output === undefined) return { output: first.output };
	if (outputPolicyKey(input.output) !== firstKey) {
		return {
			error: "agent_start received both top-level output and agents[].output with different values. Keep only the top-level output, or split into separate agent_start calls for different output policies.",
		};
	}
	return { output: input.output };
}

const SUPPORTED_AUTHORITY_FIELDS = new Set(["skill", "skills", "extensions", "extensionPolicy"]);

function authorityObject(authority: unknown): Record<string, unknown> | undefined {
	return authority && typeof authority === "object" && !Array.isArray(authority) ? authority as Record<string, unknown> : undefined;
}

function unsupportedAuthorityFields(authority: unknown): string[] {
	const obj = authorityObject(authority);
	if (!obj) return [];
	return Object.keys(obj).filter((key) => !SUPPORTED_AUTHORITY_FIELDS.has(key));
}

function skillOverride(authority: unknown): string | string[] | boolean | undefined {
	const obj = authorityObject(authority);
	if (!obj) return undefined;
	const value = obj.skills ?? obj.skill;
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
	return undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)) return value;
	return undefined;
}

function extensionPolicyOverride(authority: unknown): ChildExtensionPolicy | undefined {
	const obj = authorityObject(authority);
	if (!obj) return undefined;
	const explicit = authorityObject(obj.extensionPolicy);
	if (explicit) {
		const mode = explicit.mode === "inherit" || explicit.mode === "isolated" ? explicit.mode : undefined;
		const include = normalizeStringArray(explicit.include);
		const exclude = normalizeStringArray(explicit.exclude);
		return { ...(mode ? { mode } : {}), ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) };
	}
	const extensions = normalizeStringArray(obj.extensions);
	if (extensions) return { mode: "isolated", include: extensions };
	return undefined;
}

function taskWithContext(spec: Record<string, unknown>): string {
	const task = String(spec.task);
	const context = spec.context;
	if (!context || typeof context !== "object" || Array.isArray(context)) return task;
	const promptContext = (context as { promptContext?: unknown }).promptContext;
	const reads = (context as { reads?: unknown }).reads;
	const lines: string[] = [];
	if (typeof promptContext === "string" && promptContext.trim()) {
		lines.push("Manager-supplied context:", promptContext.trim());
	}
	if (Array.isArray(reads) && reads.every((entry) => typeof entry === "string") && reads.length > 0) {
		lines.push("Read these files before deciding or editing:", ...reads.map((entry) => `- ${entry}`));
	}
	return lines.length === 0 ? task : `${task}\n\n---\nManaged run context\n${lines.join("\n")}`;
}


function worktreeRequested(isolation: unknown): boolean | undefined {
	if (isolation === "git-worktree") return true;
	if (isolation === "shared-workspace") return false;
	if (isolation && typeof isolation === "object" && "kind" in isolation) {
		const kind = (isolation as { kind?: unknown }).kind;
		if (kind === "git-worktree") return true;
		if (kind === "shared-workspace") return false;
	}
	return undefined;
}

function formatRoles(roles: AgentConfig[], role?: string, includeDisabled?: boolean): string {
	const filtered = roles
		.filter((agent) => includeDisabled || !agent.disabled)
		.filter((agent) => !role || agent.name === role || agent.localName === role);
	if (filtered.length === 0) return role ? `No role found: ${role}` : "No agent roles found.";
	return filtered.map((agent) => {
		const parts = [
			`- ${agent.name}${agent.disabled ? " (disabled)" : ""}: ${agent.description}`,
			agent.defaultContext ? `  context: ${agent.defaultContext}` : undefined,
			agent.tools?.length ? `  tools: ${agent.tools.join(", ")}` : undefined,
			agent.model ? `  model: ${agent.model}` : undefined,
		].filter((line): line is string => Boolean(line));
		return parts.join("\n");
	}).join("\n");
}

function makeTool<P>(input: {
	name: string;
	label: string;
	description: string;
	parameters: P;
	execute: ToolDefinition<P, Details>["execute"];
	renderCall?: ToolDefinition<P, Details>["renderCall"];
}): ToolDefinition<P, Details> {
	return {
		name: input.name,
		label: input.label,
		description: input.description,
		parameters: input.parameters,
		execute: input.execute,
		renderCall: input.renderCall,
		renderResult(result, options, theme) {
			const details = result.details;
			if (details?.results?.length) {
				const c = new Container();
				c.addChild(new Text(theme.fg("toolTitle", theme.bold(input.name)), 0, 0));
				c.addChild(new Spacer(1));
				c.addChild(renderSubagentResult(result, options, theme));
				return c;
			}
			const text = result.content?.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n") ?? "";
			return new Text(`${theme.fg("toolTitle", theme.bold(input.name))}\n${text}`, 0, 0);
		},
	};
}

export function registerAgentRunTools(deps: AgentToolDeps): void {
	deps.pi.registerTool(makeTool({
		name: "agent_roles",
		label: "Agent Roles",
		description: "List or inspect roles that can be started as managed child Pi agents. Use before agent_start when role choice is unclear.",
		parameters: AgentRolesParams,
		execute(_id, params, _signal, _onUpdate, ctx) {
			const scope = normalizeScope((params as { scope?: unknown }).scope);
			const roles = deps.discoverAgents(ctx.cwd, scope).agents;
			const role = (params as { role?: unknown }).role;
			return textResult(formatRoles(roles, typeof role === "string" ? role : undefined, (params as { includeDisabled?: boolean }).includeDisabled));
		},
		renderCall(args, theme) {
			const role = (args as { role?: string }).role;
			return new Text(`${theme.fg("toolTitle", theme.bold("agent_roles"))}${role ? ` ${theme.fg("accent", role)}` : ""}`, 0, 0);
		},
	}));

	deps.pi.registerTool(makeTool({
		name: "agent_models",
		label: "Agent Models",
		description: "List models available to managed child agents. Use before setting agent_start agents[].runtime.model.",
		parameters: AgentModelsParams,
		execute(_id, params, _signal, _onUpdate, ctx) {
			const roleName = (params as { role?: unknown }).role;
			const roles = deps.discoverAgents(ctx.cwd, "both").agents;
			const role = typeof roleName === "string" ? roles.find((agent) => agent.name === roleName) : undefined;
			if (typeof roleName === "string" && !role) return errorResult(`agent_models role not found: ${roleName}`);
			return textResult(formatAgentModels(availableModelInfos(ctx), role));
		},
		renderCall(args, theme) {
			const role = (args as { role?: string }).role;
			return new Text(`${theme.fg("toolTitle", theme.bold("agent_models"))}${role ? ` ${theme.fg("accent", role)}` : ""}`, 0, 0);
		},
	}));

	deps.pi.registerTool(makeTool({
		name: "agent_start",
		label: "Agent Start",
		description: "Start one or more managed child Pi agents. Default is foreground/blocking wait; prefer that when your next step depends on child output. output is top-level and shared by all agents; identical agents[].output is tolerated and promoted, but mixed per-agent output is rejected. Use placement:'background' or wait:'none' only when you can continue independent work or the user asks to detach; do not poll agent_status just to wait.",
		parameters: AgentStartParams,
		execute(id, params, signal, onUpdate, ctx) {
			const input = params as { agents: Array<Record<string, unknown>>; placement?: "foreground" | "background"; wait?: "all" | "none"; concurrency?: number; isolation?: unknown; output?: unknown };
			if (input.placement === "background" && input.wait === "all") return errorResult("agent_start placement='background' conflicts with wait='all'. Use placement='foreground' or wait='none'.");
			if (input.placement === "foreground" && input.wait === "none") return errorResult("agent_start placement='foreground' conflicts with wait='none'. Use placement='background' or wait='all'.");
			const effectiveOutput = reconcileOutputPolicy(input);
			if (effectiveOutput.error) return errorResult(effectiveOutput.error);
			for (const spec of input.agents) {
				const unsupportedAuthority = unsupportedAuthorityFields(spec.authority);
				if (unsupportedAuthority.length > 0) return errorResult(`agent_start authority contains unsupported field(s): ${unsupportedAuthority.join(", ")}. Configure tools/write/network limits on the agent role, or add adapter support first.`);
				const unsupportedRuntime = unsupportedRuntimeFields(spec.runtime);
				if (unsupportedRuntime.length > 0) return errorResult(`agent_start runtime contains unsupported field(s): ${unsupportedRuntime.join(", ")}. Supported runtime fields: model, timeoutMs, timeoutMinutes.`);
				const unsupportedContext = unsupportedContextFields(spec.context);
				if (unsupportedContext.length > 0) return errorResult(`agent_start context contains unsupported field(s): ${unsupportedContext.join(", ")}. Supported context fields: kind, reads, promptContext.`);
			}
			const isolationError = unsupportedIsolationReason(input.isolation);
			if (isolationError) return errorResult(isolationError);
			const extensionPolicies = input.agents.map((spec) => extensionPolicyOverride(spec.authority)).filter((policy): policy is ChildExtensionPolicy => Boolean(policy));
			if (input.agents.length > 1 && extensionPolicies.length > 0) return errorResult("agent_start does not support per-agent extension authority in multi-agent mode. Start those agents separately or configure extensions on each role.");
			const extensionPolicy = extensionPolicies[0];
			const background = input.placement === "background" || input.wait === "none";
			const contextKinds = [...new Set(input.agents.map((spec) => contextKind(spec.context)).filter((kind): kind is "fresh" | "fork" => Boolean(kind)))];
			if (contextKinds.length > 1) return errorResult("agent_start multi-agent runs require one shared context kind. Start agents separately for mixed fresh/fork context.");
			const modelResolutions = new Map<Record<string, unknown>, ModelResolution>();
			for (const spec of input.agents) {
				const resolution = resolveRuntimeModelForSpec(spec, ctx);
				if (!resolution.ok) return errorResult(formatModelResolutionFailure(String(spec.role), resolution));
				modelResolutions.set(spec, resolution);
			}
			const common = {
				async: background,
				clarify: false,
				concurrency: input.concurrency,
				worktree: worktreeRequested(input.isolation),
				...(input.agents.length > 1 && contextKinds[0] ? { context: contextKinds[0] } : {}),
			};
			if (input.agents.length === 1) {
				const spec = input.agents[0]!;
				return deps.execute(id, {
					...common,
					agent: String(spec.role),
					task: taskWithContext(spec),
					cwd: typeof spec.cwd === "string" ? spec.cwd : undefined,
					context: contextKind(spec.context),
					acceptance: spec.acceptance as SubagentParamsLike["acceptance"],
					model: modelResolutions.get(spec)?.ok ? modelResolutions.get(spec)!.resolved : undefined,
					timeoutMinutes: timeoutMinutes(spec.runtime),
					...outputOverride(effectiveOutput.output),
					...(skillOverride(spec.authority) !== undefined ? { skill: skillOverride(spec.authority) } : {}),
					...(extensionPolicy ? { extensionPolicy } : {}),
				}, signal, onUpdate, ctx);
			}
			return deps.execute(id, {
				...common,
				tasks: input.agents.map((spec) => ({
					agent: String(spec.role),
					task: taskWithContext(spec),
					cwd: typeof spec.cwd === "string" ? spec.cwd : undefined,
					acceptance: spec.acceptance as SubagentParamsLike["acceptance"],
					model: modelResolutions.get(spec)?.ok ? modelResolutions.get(spec)!.resolved : undefined,
					timeoutMinutes: timeoutMinutes(spec.runtime),
					...outputOverride(effectiveOutput.output),
					...(skillOverride(spec.authority) !== undefined ? { skill: skillOverride(spec.authority) } : {}),
				})),
			}, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			const count = Array.isArray((args as { agents?: unknown }).agents) ? (args as { agents: unknown[] }).agents.length : 0;
			const placement = (args as { placement?: string }).placement ?? "foreground";
			return new Text(`${theme.fg("toolTitle", theme.bold("agent_start"))} ${count} ${theme.fg("muted", placement)}`, 0, 0);
		},
	}));

	deps.pi.registerTool(makeTool({
		name: "agent_status",
		label: "Agent Status",
		description: "Inspect active or completed managed child agent runs. Returns run state and outputFile paths for normal Read(outputFile).",
		parameters: AgentStatusParams,
		execute(id, params, signal, onUpdate, ctx) {
			const input = params as { id?: string; index?: number };
			return deps.execute(id, { action: "status", id: input.id, ...(input.index !== undefined ? { index: input.index } : {}) }, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("agent_status"))}${(args as { id?: string }).id ? ` ${theme.fg("accent", (args as { id: string }).id)}` : ""}`, 0, 0);
		},
	}));

	deps.pi.registerTool(makeTool({
		name: "agent_send",
		label: "Agent Send",
		description: "Send input, context, follow-up, or a blocker answer to a managed child agent run.",
		parameters: AgentSendParams,
		execute(id, params, signal, onUpdate, ctx) {
			const input = params as { id: string; input: string; purpose?: string; index?: number };
			const message = input.purpose ? `Purpose: ${input.purpose}\n\n${input.input}` : input.input;
			return deps.execute(id, { action: "resume", id: input.id, ...(input.index !== undefined ? { index: input.index } : {}), message }, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("agent_send"))} ${theme.fg("accent", (args as { id: string }).id ?? "?")}`, 0, 0);
		},
	}));

	deps.pi.registerTool(makeTool({
		name: "agent_stop",
		label: "Agent Stop",
		description: "Explicitly stop a managed child agent run. Requires reason. Current backend maps soft stop to Pi child interrupt/pause.",
		parameters: AgentStopParams,
		execute: async (id, params, signal, onUpdate, ctx) => {
			const input = params as { id: string; reason: string };
			const result = await deps.execute(id, { action: "interrupt", id: input.id }, signal, onUpdate, ctx);
			if (result.isError) return result;
			return { ...result, content: [...(result.content ?? []), { type: "text", text: `Stop reason: ${input.reason}` }] };
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("agent_stop"))} ${theme.fg("accent", (args as { id: string }).id ?? "?")}`, 0, 0);
		},
	}));
}
