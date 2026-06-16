import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderWidget, widgetRenderKey } from "../../tui/render.ts";
import { formatControlNoticeMessage } from "../shared/subagent-control.ts";
import {
 	type AsyncJobState,
 	type AsyncStartedEvent,
 	type AsyncStatus,
 	type ControlEvent,
 	type SubagentState,
 	POLL_INTERVAL_MS,
 	RESULTS_DIR,
 	SUBAGENT_ASYNC_CHILD_COMPLETE_EVENT,
 	SUBAGENT_CONTROL_EVENT,
 	SUBAGENT_CONTROL_INTERCOM_EVENT,
} from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import { hasLiveNestedDescendants, updateAsyncJobNestedProjection } from "../shared/nested-events.ts";

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

export function createAsyncJobTracker(pi: Pick<ExtensionAPI, "events">, state: SubagentState, asyncDirRoot: string, options: AsyncJobTrackerOptions = {}): {
 	ensurePoller: () => void;
 	handleStarted: (data: unknown) => void;
 	handleComplete: (data: unknown) => void;
 	resetJobs: (ctx?: ExtensionContext) => void;
 	restoreActiveJobs: (ctx?: ExtensionContext, restoreOptions?: { replace?: boolean }) => number;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10000;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const resultsDir = options.resultsDir ?? RESULTS_DIR;
	const rerenderWidget = (ctx: ExtensionContext, jobs = Array.from(state.asyncJobs.values())) => {
		renderWidget(ctx, jobs);
		ctx.ui.requestRender?.();
	};
	const cancelCleanup = (asyncId: string) => {
		const existingTimer = state.cleanupTimers.get(asyncId);
		if (!existingTimer) return;
		clearTimeout(existingTimer);
		state.cleanupTimers.delete(asyncId);
	};
	const scheduleCleanup = (asyncId: string) => {
		cancelCleanup(asyncId);
		const timer = setTimeout(() => {
			state.cleanupTimers.delete(asyncId);
			state.asyncJobs.delete(asyncId);
			if (state.lastUiContext) {
				rerenderWidget(state.lastUiContext);
			}
		}, completionRetentionMs);
		state.cleanupTimers.set(asyncId, timer);
	};
	const statusToJob = (asyncDir: string, status: AsyncStatus): AsyncJobState => {
		const steps = status.steps ?? [];
		const groups = normalizeParallelGroups(status.parallelGroups, steps.length, status.chainStepCount ?? steps.length);
		const activeGroup = status.currentStep !== undefined
			? groups.find((group) => status.currentStep! >= group.start && status.currentStep! < group.start + group.count)
			: undefined;
		const visibleSteps = activeGroup
			? steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => ({ ...step, index: activeGroup.start + index }))
			: steps.map((step, index) => ({ ...step, index }));
		const agents = visibleSteps.length
			? visibleSteps.map((step) => step.agent)
			: steps.map((step) => step.agent);
		return {
			asyncId: status.runId || path.basename(asyncDir),
			asyncDir,
			status: status.state,
			pid: status.pid,
			sessionId: status.sessionId,
			activityState: status.activityState,
			lastActivityAt: status.lastActivityAt,
			currentTool: status.currentTool,
			currentToolStartedAt: status.currentToolStartedAt,
			currentPath: status.currentPath,
			turnCount: status.turnCount,
			toolCount: status.toolCount,
			mode: status.mode,
			agents: agents.length ? agents : undefined,
			currentStep: status.currentStep,
			chainStepCount: status.chainStepCount,
			parallelGroups: groups.length ? groups : undefined,
			steps: visibleSteps,
			stepsTotal: visibleSteps.length || steps.length || agents.length || undefined,
			runningSteps: visibleSteps.filter((step) => step.status === "running").length,
			completedSteps: visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length,
			hasParallelGroups: groups.length > 0,
			activeParallelGroup: Boolean(activeGroup),
			startedAt: status.startedAt,
			updatedAt: status.lastUpdate ?? status.startedAt,
			sessionDir: status.sessionDir,
			outputFile: status.outputFile,
			totalTokens: status.totalTokens,
			sessionFile: status.sessionFile,
		};
	};

	const shouldRestoreStatus = (status: AsyncStatus): boolean => {
		if (status.state !== "queued" && status.state !== "running") return false;
		if (!state.currentSessionId) return false;
		return status.sessionId === state.currentSessionId;
	};

	const restoreActiveJobs = (ctx?: ExtensionContext, restoreOptions: { replace?: boolean } = {}): number => {
		if (restoreOptions.replace) {
			for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
			state.cleanupTimers.clear();
			state.asyncJobs.clear();
		}
		let restored = 0;
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(asyncDirRoot);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Failed to scan async runs in '${asyncDirRoot}':`, error);
			return 0;
		}
		for (const entry of entries) {
			const asyncDir = path.join(asyncDirRoot, entry);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(asyncDir);
			} catch {
				continue;
			}
			if (!stat.isDirectory()) continue;
			let status: AsyncStatus | null = null;
			try {
				status = readStatus(asyncDir);
			} catch (error) {
				console.error(`Failed to restore async status for '${asyncDir}':`, error);
				continue;
			}
			if (!status || !shouldRestoreStatus(status)) continue;
			const job = statusToJob(asyncDir, status);
			state.asyncJobs.set(job.asyncId, { ...state.asyncJobs.get(job.asyncId), ...job });
			cancelCleanup(job.asyncId);
			restored += 1;
		}
		if (ctx?.hasUI) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx);
		} else if (state.lastUiContext?.hasUI) {
			rerenderWidget(state.lastUiContext);
		}
		if (state.asyncJobs.size > 0) ensurePoller();
		return restored;
	};
	const emitNewControlEvents = (job: AsyncJobState) => {
		const eventsPath = path.join(job.asyncDir, "events.jsonl");
		let fd: number;
		try {
			fd = fs.openSync(eventsPath, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			console.error(`Failed to open async control events for '${job.asyncDir}':`, error);
			return;
		}
		try {
			const stat = fs.fstatSync(fd);
			const cursor = stat.size < (job.controlEventCursor ?? 0) ? 0 : (job.controlEventCursor ?? 0);
			if (stat.size <= cursor) return;
			const buffer = Buffer.alloc(stat.size - cursor);
			fs.readSync(fd, buffer, 0, buffer.length, cursor);
			const lastNewline = buffer.lastIndexOf(0x0a);
			if (lastNewline === -1) return;
			job.controlEventCursor = cursor + lastNewline + 1;
			for (const line of buffer.subarray(0, lastNewline).toString("utf-8").split("\n")) {
				if (!line.trim()) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch (error) {
					console.error(`Ignoring malformed async control event in '${eventsPath}':`, error);
					continue;
				}
				if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "subagent.control") continue;
				const record = parsed as { event?: ControlEvent; channels?: string[]; childIntercomTarget?: string; noticeText?: string; intercom?: { to?: string; message?: string } };
				if (!record.event || !Array.isArray(record.channels)) continue;
				const payload = {
					event: record.event,
					source: "async" as const,
					asyncDir: job.asyncDir,
					childIntercomTarget: record.childIntercomTarget,
					noticeText: record.noticeText ?? formatControlNoticeMessage(record.event, record.childIntercomTarget),
				};
				if (record.channels.includes("event")) {
					pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
				}
				if (record.event.type !== "active_long_running" && record.channels.includes("intercom") && record.intercom?.to && record.intercom.message) {
					pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
						...payload,
						to: record.intercom.to,
						message: record.intercom.message,
					});
				}
			}
		} catch (error) {
			console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
		} finally {
			fs.closeSync(fd);
		}
	};

const terminalStepStatus = (status: string | undefined): "completed" | "failed" | "paused" | undefined => {
	if (status === "complete" || status === "completed") return "completed";
	if (status === "failed") return "failed";
	if (status === "paused") return "paused";
	return undefined;
};

const emitNewTerminalStepEvents = (job: AsyncJobState): void => {
	if (!job.steps?.length) return;
	const seen = job.notifiedStepKeys ?? new Set<string>();
	job.notifiedStepKeys = seen;
	for (const [visibleIndex, step] of job.steps.entries()) {
		const terminalStatus = terminalStepStatus(step.status);
		if (!terminalStatus) continue;
		const index = step.index ?? visibleIndex;
		const key = `${index}:${terminalStatus}:${step.endedAt ?? ""}:${step.exitCode ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const outputFile = path.join(job.asyncDir, `output-${index}.log`);
		pi.events.emit(SUBAGENT_ASYNC_CHILD_COMPLETE_EVENT, {
			id: job.asyncId,
			runId: job.asyncId,
			sessionId: job.sessionId,
			asyncDir: job.asyncDir,
			mode: job.mode,
			agent: step.agent,
			index,
			taskIndex: index,
			totalTasks: job.stepsTotal ?? job.steps.length,
			status: terminalStatus,
			success: terminalStatus === "completed",
			state: terminalStatus === "completed" ? "complete" : terminalStatus === "failed" ? "failed" : "paused",
			summary: step.error ?? step.issues?.find((issue) => issue.severity === "warning")?.message ?? step.recentOutput?.filter(Boolean).slice(-3).join("\n") ?? terminalStatus,
			error: step.error,
			outputFile: fs.existsSync(outputFile) ? outputFile : undefined,
			sessionFile: step.sessionFile,
			acceptance: step.acceptance,
			issues: step.issues,
			verdict: step.verdict,
			durationMs: step.durationMs,
			timestamp: step.endedAt ?? Date.now(),
		});
	}
};

	const ensurePoller = () => {
		if (state.poller) return;
		state.poller = setInterval(() => {
			if (state.asyncJobs.size === 0) {
				if (state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext, []);
				if (state.poller) {
					clearInterval(state.poller);
					state.poller = null;
				}
				return;
			}

			let widgetChanged = false;
			for (const job of state.asyncJobs.values()) {
				const widgetStateBefore = widgetRenderKey(job);
				let nestedRefreshFailed = false;
				const refreshNestedProjection = () => {
					try {
						updateAsyncJobNestedProjection(job);
					} catch (error) {
						nestedRefreshFailed = true;
						console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
					}
				};
				const reconcileNestedDescendants = () => {
					try {
						if (job.nestedRoute) reconcileNestedAsyncDescendants(job.nestedRoute, { resultsDir, kill: options.kill, now: options.now });
					} catch (error) {
						nestedRefreshFailed = true;
						console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
					}
					refreshNestedProjection();
				};
				try {
					emitNewControlEvents(job);
					reconcileNestedDescendants();
					const reconciliation = reconcileAsyncRun(job.asyncDir, {
						resultsDir,
						kill: options.kill,
						now: options.now,
						startedRun: {
							runId: job.asyncId,
							pid: job.pid,
							sessionId: job.sessionId,
							mode: job.mode,
							agents: job.agents,
							chainStepCount: job.chainStepCount,
							parallelGroups: job.parallelGroups,
							startedAt: job.startedAt,
							sessionFile: job.sessionFile,
						},
					});
					const status = reconciliation.status ?? readStatus(job.asyncDir);
					if (status) {
						const previousStatus = job.status;
						job.status = status.state;
						if (job.status !== "complete" && job.status !== "failed" && job.status !== "paused") cancelCleanup(job.asyncId);
						job.sessionId = status.sessionId ?? job.sessionId;
						job.activityState = status.activityState;
						job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
						job.currentTool = status.currentTool;
						job.currentToolStartedAt = status.currentToolStartedAt;
						job.currentPath = status.currentPath;
						job.turnCount = status.turnCount ?? job.turnCount;
						job.toolCount = status.toolCount ?? job.toolCount;
						job.mode = status.mode;
						job.currentStep = status.currentStep ?? job.currentStep;
						job.chainStepCount = status.chainStepCount ?? job.chainStepCount;
						job.startedAt = status.startedAt ?? job.startedAt;
						if (status.lastUpdate !== undefined) job.updatedAt = status.lastUpdate;
						if (status.steps?.length) {
							const groups = normalizeParallelGroups(status.parallelGroups, status.steps.length, status.chainStepCount ?? status.steps.length);
							job.parallelGroups = groups.length ? groups : job.parallelGroups;
							job.hasParallelGroups = groups.length > 0 || job.hasParallelGroups;
							const activeGroup = status.currentStep !== undefined
								? groups.find((group) => status.currentStep! >= group.start && status.currentStep! < group.start + group.count)
								: undefined;
							const visibleSteps = activeGroup
								? status.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => ({ ...step, index: activeGroup.start + index }))
								: status.steps.map((step, index) => ({ ...step, index }));
							job.activeParallelGroup = Boolean(activeGroup);
							job.agents = visibleSteps.map((step) => step.agent);
							job.steps = visibleSteps;
							refreshNestedProjection();
							job.stepsTotal = visibleSteps.length;
							job.runningSteps = visibleSteps.filter((step) => step.status === "running").length;
							job.completedSteps = visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length;
							if (status.state === "complete") job.completedSteps = visibleSteps.length;
						}
						job.sessionDir = status.sessionDir ?? job.sessionDir;
						job.outputFile = status.outputFile ?? job.outputFile;
						job.totalTokens = status.totalTokens ?? job.totalTokens;
						job.sessionFile = status.sessionFile ?? job.sessionFile;
						emitNewTerminalStepEvents(job);
						if ((job.status === "complete" || job.status === "failed" || job.status === "paused") && !hasLiveNestedDescendants(job.nestedChildren) && (previousStatus !== job.status || !state.cleanupTimers.has(job.asyncId))) {
							scheduleCleanup(job.asyncId);
						}
						if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
						continue;
					}
					if (job.status === "queued") {
						job.status = "running";
						job.updatedAt = Date.now();
					}
				} catch (error) {
					if (job.status !== "failed") {
						console.error(`Failed to read async status for '${job.asyncDir}':`, error);
						job.status = "failed";
						job.updatedAt = Date.now();
					}
					if (!hasLiveNestedDescendants(job.nestedChildren) && !state.cleanupTimers.has(job.asyncId)) {
						scheduleCleanup(job.asyncId);
					}
				}
				if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
				if (job.status === "running" || job.status === "queued") {
					const uiClock = Math.floor(Date.now() / 500);
					if (job.lastWidgetUiClock !== uiClock) {
						job.lastWidgetUiClock = uiClock;
						widgetChanged = true;
					}
				}
			}

			if (widgetChanged && state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext);
		}, pollIntervalMs);
		state.poller.unref?.();
	};

	const handleStarted = (data: unknown) => {
		const info = data as AsyncStartedEvent;
		if (!info.id) return;
		const now = Date.now();
		const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
		const rawAgents = info.agents?.length ? info.agents : info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		const validParallelGroups = normalizeParallelGroups(info.parallelGroups, Number.MAX_SAFE_INTEGER, info.chainStepCount ?? Number.MAX_SAFE_INTEGER);
		const firstGroup = validParallelGroups.find((group) => group.start === 0);
		const firstGroupCount = firstGroup?.count;
		const agents = firstGroupCount && firstGroupCount > 0
			? rawAgents?.slice(0, firstGroupCount)
			: rawAgents;
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			pid: typeof info.pid === "number" ? info.pid : undefined,
			...(typeof info.sessionId === "string" ? { sessionId: info.sessionId } : {}),
			mode: info.mode ?? (info.chain ? "chain" : "single"),
			agents,
			chainStepCount: info.chainStepCount,
			parallelGroups: validParallelGroups,
			nestedRoute: info.nestedRoute,
			stepsTotal: firstGroupCount ?? agents?.length,
			hasParallelGroups: validParallelGroups.length > 0,
			activeParallelGroup: Boolean(firstGroupCount && firstGroupCount > 0),
			startedAt: now,
			updatedAt: now,
		});
		ensurePoller();
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
	};

	const handleComplete = (data: unknown) => {
		const result = data as { id?: string; success?: boolean; asyncDir?: string };
		const asyncId = result.id;
		if (!asyncId) return;
		const job = state.asyncJobs.get(asyncId);
		let nestedRefreshFailed = false;
		if (job) {
			job.status = result.success ? "complete" : "failed";
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
			try {
				updateAsyncJobNestedProjection(job);
			} catch (error) {
				nestedRefreshFailed = true;
				console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
			}
		}
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
		if (!nestedRefreshFailed && !hasLiveNestedDescendants(job?.nestedChildren)) scheduleCleanup(asyncId);
	};

	const resetJobs = (ctx?: ExtensionContext) => {
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		state.foregroundControls?.clear();
		state.lastForegroundControlId = null;
		state.resultFileCoalescer.clear();
		if (ctx?.hasUI) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx, []);
		}
	};

	return { ensurePoller, handleStarted, handleComplete, resetJobs, restoreActiveJobs };
}
