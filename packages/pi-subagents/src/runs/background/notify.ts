/**
 * Subagent completion notifications.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.ts";
import { SUBAGENT_ASYNC_CHILD_COMPLETE_EVENT, SUBAGENT_ASYNC_COMPLETE_EVENT, type ChildIssue, type ChildVerdict } from "../../shared/types.ts";

interface ChainStepResult {
	agent: string;
	output: string;
	success: boolean;
}

export interface SubagentNotifyDetails {
	agent: string;
	status: "completed" | "failed" | "paused";
	taskInfo?: string;
	resultPreview: string;
	durationMs?: number;
	sessionLabel?: string;
	sessionValue?: string;
}

interface SubagentResult {
	id: string | null;
	agent: string | null;
	success: boolean;
	summary: string;
	exitCode?: number;
	state?: string;
	timestamp: number;
	durationMs?: number;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	results?: ChainStepResult[];
	taskIndex?: number;
	totalTasks?: number;
}

interface SubagentChildResult {
	id: string | null;
	runId?: string;
	agent: string | null;
	status?: "completed" | "failed" | "paused";
	success?: boolean;
	summary?: string;
	error?: string;
	timestamp?: number;
	durationMs?: number;
	sessionId?: string;
	sessionFile?: string;
	outputFile?: string;
	taskIndex?: number;
	totalTasks?: number;
	issues?: ChildIssue[];
	verdict?: ChildVerdict;
}

function formatTimestampLine(label: string, timestamp: number | undefined): string | undefined {
	return typeof timestamp === "number" ? `${label}: ${new Date(timestamp).toISOString()}` : undefined;
}

function formatInspectCommand(id: string | null | undefined, index?: number): string | undefined {
	if (!id) return undefined;
	return index !== undefined
		? `Inspect: agent_status({ id: "${id}", index: ${index} })`
		: `Inspect: agent_status({ id: "${id}" })`;
}

function formatResumeCommand(id: string | null | undefined, index?: number): string | undefined {
	if (!id) return undefined;
	return index !== undefined
		? `Resume: agent_send({ id: "${id}", index: ${index}, input: "..." })`
		: `Resume: agent_send({ id: "${id}", input: "..." })`;
}

function sendPassiveNotice(pi: ExtensionAPI, content: string): void {
	pi.sendMessage({ customType: "subagent-notify", content, display: true });
}

function sendRootCompletionFollowUp(pi: ExtensionAPI, content: string): void {
	const maybeUserMessage = (pi as { sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void }).sendUserMessage;
	if (typeof maybeUserMessage === "function") {
		maybeUserMessage.call(pi, content, { deliverAs: "followUp" });
		return;
	}
	pi.sendMessage(
		{ customType: "subagent-notify", content, display: true },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

export default function registerSubagentNotify(pi: ExtensionAPI): void {
	const unsubscribeStoreKey = "__pi_subagents_notify_unsubscribe__";
	const globalStore = globalThis as Record<string, unknown>;
	const previousUnsubscribe = globalStore[unsubscribeStoreKey];
	if (typeof previousUnsubscribe === "function") {
		try {
			previousUnsubscribe();
		} catch {
			// Best effort cleanup for stale handlers from an older reload.
		}
	}

	const seen = getGlobalSeenMap("__pi_subagents_notify_seen__");
	const ttlMs = 10 * 60 * 1000;

	const handleComplete = (data: unknown) => {
		const result = data as SubagentResult;
		const now = Date.now();
		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) return;

		const agent = result.agent ?? "unknown";
		const summary = typeof result.summary === "string" ? result.summary : "";
		const paused = !result.success && (
			result.exitCode === 0
			|| result.state === "paused"
			|| summary.startsWith("Paused after interrupt.")
		);
		const status = paused ? "paused" : result.success ? "completed" : "failed";

		const taskInfo =
			result.taskIndex !== undefined && result.totalTasks !== undefined
				? ` (${result.taskIndex + 1}/${result.totalTasks})`
				: "";

		const sessionLine = result.shareUrl
			? `Session: ${result.shareUrl}`
			: result.shareError
				? `Session share error: ${result.shareError}`
				: result.sessionFile
					? `Session file: ${result.sessionFile}`
					: undefined;

		const displaySummary = summary.trim() ? summary : "(no output)";
		const pausedLines = paused ? [
			"Note: this is a terminal paused result, not an active running job. If it appeared late, the result watcher delivered an already-paused run.",
			formatTimestampLine("Paused at", result.timestamp),
			formatInspectCommand(result.id),
			formatResumeCommand(result.id),
		] : [];
		const content = [
			`Background task ${paused ? "paused (terminal)" : status}: **${agent}**${taskInfo}`,
			"",
			displaySummary,
			...pausedLines.filter((line): line is string => Boolean(line)),
			sessionLine ? "" : undefined,
			sessionLine,
		]
			.filter((line) => line !== undefined)
			.join("\n");

		if (paused) sendPassiveNotice(pi, content);
		else sendRootCompletionFollowUp(pi, content);
	};

const handleChildComplete = (data: unknown) => {
	const result = data as SubagentChildResult;
	const now = Date.now();
	const key = buildCompletionKey({ id: `${result.id ?? result.runId ?? "unknown"}:${result.taskIndex ?? "?"}:${result.status ?? "unknown"}`, sessionId: result.sessionId }, "notify-child");
	if (markSeenWithTtl(seen, key, now, ttlMs)) return;

	const agent = result.agent ?? "unknown";
	const taskInfo = result.taskIndex !== undefined && result.totalTasks !== undefined
		? ` (${result.taskIndex + 1}/${result.totalTasks})`
		: "";
	const status = result.status ?? (result.success ? "completed" : "failed");
	const hasWarning = result.verdict === "warning" || Boolean(result.issues?.some((issue) => issue.severity === "warning"));
	const displayStatus = status === "completed" && hasWarning ? "completed with warning" : status;
	const summary = result.error ?? result.issues?.find((issue) => issue.severity === "warning")?.message ?? result.summary ?? "";
	const outputLine = result.outputFile ? `Output: ${result.outputFile}` : undefined;
	const sessionLine = result.sessionFile ? `Session file: ${result.sessionFile}` : undefined;
	const runId = result.runId ?? result.id;
	const pausedLines = status === "paused" ? [
		"Note: this is a terminal paused result, not an active running child. If it appeared late, the result watcher delivered an already-paused child.",
		formatTimestampLine("Paused at", result.timestamp),
		formatInspectCommand(runId, result.taskIndex),
		formatResumeCommand(runId, result.taskIndex),
	] : [];
	const content = [
		`Background child ${status === "paused" ? "paused (terminal)" : displayStatus}: **${agent}**${taskInfo}`,
		"",
		summary.trim() ? summary : "(no output)",
		...pausedLines.filter((line): line is string => Boolean(line)),
		outputLine ? "" : undefined,
		outputLine,
		sessionLine,
	].filter((line) => line !== undefined).join("\n");

	sendPassiveNotice(pi, content);
};

	const unsubscribeComplete = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete);
	const unsubscribeChildComplete = pi.events.on(SUBAGENT_ASYNC_CHILD_COMPLETE_EVENT, handleChildComplete);
	globalStore[unsubscribeStoreKey] = () => {
		unsubscribeComplete();
		unsubscribeChildComplete();
	};
}
