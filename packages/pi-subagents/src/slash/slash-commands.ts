import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { discoverAgents } from "../agents/agents.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { SlashSubagentResponse, SlashSubagentUpdate } from "./slash-bridge.ts";
import {
	applySlashUpdate,
	buildSlashInitialResult,
	failSlashResult,
	finalizeSlashResult,
} from "./slash-live-state.ts";
import {
	SLASH_RESULT_TYPE,
	SLASH_SUBAGENT_CANCEL_EVENT,
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	SLASH_SUBAGENT_STARTED_EVENT,
	SLASH_SUBAGENT_UPDATE_EVENT,
	type SingleResult,
	type SubagentState,
} from "../shared/types.ts";

function extractExecutionFlags(rawArgs: string): { args: string; bg: boolean; fork: boolean } {
	let args = rawArgs.trim();
	let bg = false;
	let fork = false;
	while (true) {
		if (args.endsWith(" --bg") || args === "--bg") {
			bg = true;
			args = args === "--bg" ? "" : args.slice(0, -5).trim();
			continue;
		}
		if (args.endsWith(" --fork") || args === "--fork") {
			fork = true;
			args = args === "--fork" ? "" : args.slice(0, -7).trim();
			continue;
		}
		break;
	}
	return { args, bg, fork };
}

function makeAgentCompletions(state: SubagentState) {
	return (prefix: string) => {
		if (!state.baseCwd || prefix.includes(" ")) return null;
		return discoverAgents(state.baseCwd, "both").agents
			.filter((agent) => !agent.disabled && agent.name.startsWith(prefix))
			.map((agent) => ({ value: agent.name, label: agent.name }));
	};
}

function parseTargetAndMessage(rawArgs: string, usage: string, ctx: ExtensionContext): { id: string; message: string } | undefined {
	const delimiter = rawArgs.indexOf(" -- ");
	if (delimiter === -1) {
		ctx.ui.notify(usage, "error");
		return undefined;
	}
	const id = rawArgs.slice(0, delimiter).trim();
	const message = rawArgs.slice(delimiter + 4).trim();
	if (!id || !message) {
		ctx.ui.notify(usage, "error");
		return undefined;
	}
	return { id, message };
}

function extractSlashMessageText(content: string | Array<{ type?: string; text?: string }>): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function formatExportPathList(paths: string[]): string {
	return paths.map((file) => `- \`${file}\``).join("\n");
}

function collectResultPaths(results: SingleResult[], getPath: (result: SingleResult) => string | undefined): string[] {
	return results
		.map(getPath)
		.filter((file): file is string => typeof file === "string" && file.length > 0);
}

function buildSlashExportText(response: SlashSubagentResponse): string {
	const output = extractSlashMessageText(response.result.content) || response.errorText || "(no output)";
	const results = response.result.details?.results ?? [];
	const sessionFiles = collectResultPaths(results, (result) => result.sessionFile);
	const savedOutputs = collectResultPaths(results, (result) => result.savedOutputPath);
	const artifactOutputs = collectResultPaths(results, (result) => result.artifactPaths?.outputPath);
	const sections = ["## Agent run result", output];
	if (sessionFiles.length > 0) sections.push("## Child session exports", formatExportPathList(sessionFiles));
	if (savedOutputs.length > 0) sections.push("## Saved outputs", formatExportPathList(savedOutputs));
	if (artifactOutputs.length > 0) sections.push("## Artifact outputs", formatExportPathList(artifactOutputs));
	return sections.join("\n\n");
}

function persistSlashSessionSnapshot(ctx: ExtensionContext): void {
	try {
		if (!ctx.sessionManager) return;
		const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & { _rewriteFile?: () => void; flushed?: boolean };
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile || typeof sessionManager._rewriteFile !== "function") return;
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		sessionManager._rewriteFile();
		sessionManager.flushed = true;
	} catch (error) {
		console.error("Failed to persist managed-agent slash session snapshot for export:", error);
	}
}

async function requestSlashRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	requestId: string,
	params: SubagentParamsLike,
): Promise<SlashSubagentResponse> {
	return new Promise((resolve, reject) => {
		let done = false;
		let started = false;
		const startTimeout = setTimeout(() => {
			finish(() => reject(new Error("Managed-agent slash bridge did not start within 15s. Ensure the extension is loaded correctly.")));
		}, 15_000);
		const onStarted = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			if ((data as { requestId?: unknown }).requestId !== requestId) return;
			started = true;
			clearTimeout(startTimeout);
			if (ctx.hasUI) ctx.ui.setStatus("managed-agent-slash", "running...");
		};
		const onResponse = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const response = data as Partial<SlashSubagentResponse>;
			if (response.requestId !== requestId) return;
			clearTimeout(startTimeout);
			finish(() => resolve(response as SlashSubagentResponse));
		};
		const onUpdate = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const update = data as SlashSubagentUpdate;
			if (update.requestId !== requestId) return;
			applySlashUpdate(requestId, update);
			if (!ctx.hasUI) return;
			const tool = update.currentTool ? ` ${update.currentTool}` : "";
			const count = update.toolCount ?? 0;
			ctx.ui.setStatus("managed-agent-slash", `${count} tools${tool} | Ctrl+O live detail`);
		};
		const onTerminalInput = ctx.hasUI
			? ctx.ui.onTerminalInput((input) => {
				if (!matchesKey(input, Key.escape)) return undefined;
				pi.events.emit(SLASH_SUBAGENT_CANCEL_EVENT, { requestId });
				finish(() => reject(new Error("Cancelled")));
				return { consume: true };
			})
			: undefined;
		const unsubStarted = pi.events.on(SLASH_SUBAGENT_STARTED_EVENT, onStarted);
		const unsubResponse = pi.events.on(SLASH_SUBAGENT_RESPONSE_EVENT, onResponse);
		const unsubUpdate = pi.events.on(SLASH_SUBAGENT_UPDATE_EVENT, onUpdate);
		const finish = (next: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(startTimeout);
			unsubStarted();
			unsubResponse();
			unsubUpdate();
			onTerminalInput?.();
			next();
		};
		pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params });
		if (!started && done) return;
		if (!started) finish(() => reject(new Error("No managed-agent slash bridge responded. Ensure the extension is loaded correctly.")));
	});
}

async function runSlashAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: SubagentParamsLike,
): Promise<void> {
	if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
	const requestId = randomUUID();
	const initialDetails = buildSlashInitialResult(requestId, params);
	const initialText = extractSlashMessageText(initialDetails.result.content) || "Running managed agent...";
	pi.sendMessage({ customType: SLASH_RESULT_TYPE, content: initialText, display: true, details: initialDetails });
	persistSlashSessionSnapshot(ctx);
	try {
		const response = await requestSlashRun(pi, ctx, requestId, params);
		const finalDetails = finalizeSlashResult(response);
		pi.sendMessage({ customType: SLASH_RESULT_TYPE, content: buildSlashExportText(response), display: true, details: finalDetails });
		persistSlashSessionSnapshot(ctx);
		if (ctx.hasUI) ctx.ui.setStatus("managed-agent-slash", undefined);
		if (response.isError && ctx.hasUI) ctx.ui.notify(response.errorText || "Managed agent failed", "error");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const failedDetails = failSlashResult(requestId, params, message);
		pi.sendMessage({ customType: SLASH_RESULT_TYPE, content: `## Agent run result\n\n${message}`, display: true, details: failedDetails });
		persistSlashSessionSnapshot(ctx);
		if (ctx.hasUI) ctx.ui.setStatus("managed-agent-slash", undefined);
		if (message === "Cancelled") {
			if (ctx.hasUI) ctx.ui.notify("Cancelled", "warning");
			return;
		}
		if (ctx.hasUI) ctx.ui.notify(message, "error");
	}
}

export function registerSlashCommands(pi: ExtensionAPI, state: SubagentState): void {
	pi.registerCommand("agent-start", {
		description: "Start a managed child agent: /agent-start role -- task [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const delimiter = cleanedArgs.indexOf(" -- ");
			const usage = "Usage: /agent-start <role> -- <task> [--bg] [--fork]";
			if (delimiter === -1) {
				ctx.ui.notify(usage, "error");
				return;
			}
			const role = cleanedArgs.slice(0, delimiter).trim();
			const task = cleanedArgs.slice(delimiter + 4).trim();
			if (!role || !task) {
				ctx.ui.notify(usage, "error");
				return;
			}
			if (!state.baseCwd) {
				ctx.ui.notify("Managed-agent session cwd is not initialized yet", "error");
				return;
			}
			const agents = discoverAgents(state.baseCwd, "both").agents;
			if (!agents.find((agent) => !agent.disabled && agent.name === role)) {
				ctx.ui.notify(`Unknown managed-agent role: ${role}`, "error");
				return;
			}
			await runSlashAgent(pi, ctx, {
				agent: role,
				task,
				clarify: false,
				agentScope: "both",
				...(bg ? { async: true } : {}),
				...(fork ? { context: "fork" as const } : {}),
			});
		},
	});

	pi.registerCommand("agent-status", {
		description: "Inspect managed child-agent runs: /agent-status [run-id]",
		handler: async (args, ctx) => {
			const id = args.trim();
			await runSlashAgent(pi, ctx, { action: "status", ...(id ? { id } : {}) });
		},
	});

	pi.registerCommand("agent-send", {
		description: "Send follow-up to a managed child-agent run: /agent-send run-id -- message",
		handler: async (args, ctx) => {
			const parsed = parseTargetAndMessage(args.trim(), "Usage: /agent-send <run-id> -- <message>", ctx);
			if (!parsed) return;
			await runSlashAgent(pi, ctx, { action: "resume", id: parsed.id, message: parsed.message });
		},
	});

	pi.registerCommand("agent-stop", {
		description: "Soft-stop a managed child-agent run: /agent-stop run-id -- reason",
		handler: async (args, ctx) => {
			const parsed = parseTargetAndMessage(args.trim(), "Usage: /agent-stop <run-id> -- <reason>", ctx);
			if (!parsed) return;
			await runSlashAgent(pi, ctx, { action: "interrupt", id: parsed.id, message: parsed.message });
		},
	});

	pi.registerCommand("agents-doctor", {
		description: "Show managed-agent diagnostics",
		handler: async (_args, ctx) => {
			await runSlashAgent(pi, ctx, { action: "doctor" });
		},
	});
}
