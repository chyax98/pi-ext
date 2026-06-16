import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { renderSubagentResult } from "../tui/render.ts";
import type { Details } from "../shared/types.ts";
import type { WorkflowParamsLike } from "../workflow/workflow-tool.ts";

const Placement = Type.String({ enum: ["foreground", "background"], description: "Runtime attachment. Workflows are background runs with persistent status; foreground attaches and waits." });
const WorkflowListParams = Type.Object({}, { additionalProperties: false });

const WorkflowShowParams = Type.Object({
	name: Type.String(),
}, { additionalProperties: false });

const WorkflowStartParams = Type.Object({
	name: Type.String({ description: "Saved workflow name." }),
	input: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true, description: "Workflow input arguments." })),
	placement: Type.Optional(Placement),
}, { additionalProperties: false });

const WorkflowStatusParams = Type.Object({
	id: Type.String({ description: "Workflow run id." }),
}, { additionalProperties: false });

const WorkflowStopParams = Type.Object({
	id: Type.String({ description: "Workflow run id." }),
	reason: Type.String({ description: "Why stopping this workflow run." }),
}, { additionalProperties: false });

const WorkflowSendParams = Type.Object({
	id: Type.String({ description: "Workflow run id." }),
	input: Type.String({ description: "Input/update/answer for workflow inbox." }),
	purpose: Type.Optional(Type.String({ enum: ["question", "answer", "add-context", "change-task", "follow-up"] })),
}, { additionalProperties: false });

interface WorkflowToolDeps {
	pi: ExtensionAPI;
	execute: (
		id: string,
		params: WorkflowParamsLike,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>> | AgentToolResult<Details>;
}

const WORKFLOW_ROOT = path.join(os.homedir(), ".pi", "agent", "workflows");
const SAVED_DIR = path.join(WORKFLOW_ROOT, "saved");
const BUNDLED_SAVED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows", "saved");

function textResult(text: string): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], details: { mode: "management", results: [] } };
}

function errorResult(text: string): AgentToolResult<Details> {
	return { ...textResult(text), isError: true };
}

function sanitizeName(name: string): string {
	const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "workflow";
}

function savedWorkflowDir(name: string): string | undefined {
	const safeName = sanitizeName(name);
	const candidates = [path.join(SAVED_DIR, safeName), path.join(BUNDLED_SAVED_DIR, safeName)];
	return candidates.find((dir) => fs.existsSync(path.join(dir, "workflow.js")));
}

function showSavedWorkflow(name: string): AgentToolResult<Details> {
	const safeName = sanitizeName(name);
	const dir = savedWorkflowDir(name);
	if (!dir) {
		return { ...textResult(`Workflow not found: ${name}`), isError: true };
	}
	const scriptPath = path.join(dir, "workflow.js");
	const metadataPath = path.join(dir, "metadata.json");
	const metadata = fs.existsSync(metadataPath) ? fs.readFileSync(metadataPath, "utf-8").trim() : "(no metadata)";
	const script = fs.readFileSync(scriptPath, "utf-8");
	return textResult([
		`Workflow: ${safeName}`,
		`Script: ${scriptPath}`,
		"",
		"Metadata:",
		metadata,
		"",
		"Script preview:",
		...script.split("\n").slice(0, 80),
		...(script.split("\n").length > 80 ? ["... (truncated)"] : []),
	].join("\n"));
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

export function registerWorkflowRunTools(deps: WorkflowToolDeps): void {
	deps.pi.registerTool(makeTool({
		name: "workflow_list",
		label: "Workflow List",
		description: "List saved workflows and recent workflow runs.",
		parameters: WorkflowListParams,
		execute(id, _params, signal, onUpdate, ctx) {
			return deps.execute(id, { action: "list" }, signal, onUpdate, ctx);
		},
	}));

	deps.pi.registerTool(makeTool({
		name: "workflow_show",
		label: "Workflow Show",
		description: "Show a saved workflow definition and metadata before starting it.",
		parameters: WorkflowShowParams,
		execute(_id, params) {
			return showSavedWorkflow((params as { name: string }).name);
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("workflow_show"))} ${theme.fg("accent", (args as { name: string }).name ?? "?")}`, 0, 0);
		},
	}));

	deps.pi.registerTool(makeTool({
		name: "workflow_start",
		label: "Workflow Start",
		description: "Start a saved workflow SOP as a background run with persistent status. Use placement:'foreground' to attach/watch until terminal.",
		parameters: WorkflowStartParams,
		execute(id, params, signal, onUpdate, ctx) {
			const input = params as { name: string; input?: Record<string, unknown>; placement?: "foreground" | "background" };
			return deps.execute(id, {
				action: "run",
				workflowName: input.name,
				args: input.input ?? {},
				placement: input.placement ?? "background",
			}, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("workflow_start"))} ${theme.fg("accent", (args as { name: string }).name ?? "?")}`, 0, 0);
		},
	}));

	deps.pi.registerTool(makeTool({
		name: "workflow_status",
		label: "Workflow Status",
		description: "Inspect workflow run status, checkpoints, events, and output paths.",
		parameters: WorkflowStatusParams,
		execute(id, params, signal, onUpdate, ctx) {
			return deps.execute(id, { action: "status", runId: (params as { id: string }).id }, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("workflow_status"))} ${theme.fg("accent", (args as { id: string }).id ?? "?")}`, 0, 0);
		},
	}));

	deps.pi.registerTool(makeTool({
		name: "workflow_send",
		label: "Workflow Send",
		description: "Send input, context, follow-up, or a blocker answer to a workflow run inbox.",
		parameters: WorkflowSendParams,
		execute(id, params, signal, onUpdate, ctx) {
			const input = params as { id: string; input: string; purpose?: string };
			return deps.execute(id, { action: "send", runId: input.id, message: input.input, purpose: input.purpose }, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("workflow_send"))} ${theme.fg("accent", (args as { id: string }).id ?? "?")}`, 0, 0);
		},
	}));

	deps.pi.registerTool(makeTool({
		name: "workflow_stop",
		label: "Workflow Stop",
		description: "Explicitly stop a workflow run. Requires a reason.",
		parameters: WorkflowStopParams,
		execute: async (id, params, signal, onUpdate, ctx) => {
			const input = params as { id: string; reason: string };
			const result = await deps.execute(id, { action: "stop", runId: input.id, message: input.reason }, signal, onUpdate, ctx);
			if (result.isError) return result;
			return { ...result, content: [...(result.content ?? []), { type: "text", text: `Stop reason: ${input.reason}` }] };
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("workflow_stop"))} ${theme.fg("accent", (args as { id: string }).id ?? "?")}`, 0, 0);
		},
	}));
}
