import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestedSubagentTimeoutMs, type ChildExtensionPolicy, type Details } from "../shared/types.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";

export interface WorkflowParamsLike {
	action: "run" | "status" | "stop" | "list" | "send";
	name?: string;
	script?: string;
	scriptPath?: string;
	workflowName?: string;
	args?: Record<string, unknown>;
	cwd?: string;
	async?: boolean;
	limits?: { maxAgents?: number; concurrency?: number; maxRuntimeMs?: number };
	writes?: "none" | "active-worktree" | "worktree";
	worktree?: { enabled?: boolean; base?: string; setupHook?: string };
	extensionPolicy?: ChildExtensionPolicy;
	runId?: string;
	message?: string;
	purpose?: "question" | "answer" | "add-context" | "change-task" | "follow-up";
	placement?: "foreground" | "background";
}

interface WorkflowEvent {
	v: 1;
	seq: number;
	ts: string;
	runId: string;
	type: string;
	level?: "debug" | "info" | "warn" | "error";
	nodeId?: string;
	parentNodeId?: string;
	agentRunId?: string;
	data?: Record<string, unknown>;
}

interface WorkflowRunState {
	runId: string;
	status: "created" | "running" | "completed" | "failed" | "paused" | "stopped";
	createdAt: string;
	updatedAt: string;
	cwd: string;
	scriptPath: string;
	argsPath: string;
	eventsPath: string;
	finalPath?: string;
	inboxPath?: string;
	finalJsonPath?: string;
	error?: string;
	agentCount: number;
	runnerId?: string;
	runnerPid?: number;
	runnerHeartbeatAt?: string;
	orphanedReason?: string;
}

interface AgentRunSpec {
	agent: string | { name: string; description?: string; prompt: string; tools?: string[]; disallowedTools?: string[]; model?: string; extensions?: string[] };
	task: string;
	cwd?: string;
	context?: "fresh" | "fork";
	model?: string;
	tools?: string[];
	disallowedTools?: string[];
	extensions?: string[];
	extensionPolicy?: ChildExtensionPolicy;
	skills?: string[] | boolean;
	outputSchema?: Record<string, unknown>;
	acceptance?: unknown;
	writes?: "none" | "active-worktree" | "worktree";
	worktree?: boolean | { setupHook?: string };
	timeoutMinutes?: number;
	background?: boolean;
	maxTurns?: number;
}

interface AgentResult {
	id: string;
	agent: string;
	status: "completed" | "failed" | "cancelled" | "paused" | "running";
	output: string;
	structuredOutput?: unknown;
	error?: string;
	artifacts?: Record<string, string | undefined>;
	asyncId?: string;
	asyncDir?: string;
	raw?: unknown;
}

type ExecuteSubagent = (
	id: string,
	params: SubagentParamsLike,
	signal: AbortSignal,
	onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
	ctx: ExtensionContext,
) => Promise<AgentToolResult<Details>> | AgentToolResult<Details>;

const WORKFLOW_ROOT = path.join(os.homedir(), ".pi", "agent", "workflows");
const SAVED_DIR = path.join(WORKFLOW_ROOT, "saved");
const BUNDLED_SAVED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows", "saved");
const RUNS_DIR = path.join(WORKFLOW_ROOT, "runs");
const WORKFLOW_HEARTBEAT_MS = 1000;
const WORKFLOW_STALE_MS = 5000;
type ActiveWorkflowRun = { promise: Promise<AgentToolResult<Details>>; runnerId: string; startedAt: number };

function activeWorkflowRuns(): Map<string, ActiveWorkflowRun> {
	const store = globalThis as Record<string, unknown>;
	const key = "__piSubagentsActiveWorkflowRuns";
	if (!(store[key] instanceof Map)) store[key] = new Map<string, ActiveWorkflowRun>();
	return store[key] as Map<string, ActiveWorkflowRun>;
}

class WorkflowStopError extends Error {
 constructor(message = "workflow stopped") {
  super(message);
  this.name = "WorkflowStopError";
 }
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, value: unknown): void {
	ensureDir(path.dirname(filePath));
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function expandTilde(input: string): string {
	return input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
}

function sanitizeName(name: string): string {
	const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "workflow";
}


function workflowScriptPath(name: string): string | undefined {
	const safeName = sanitizeName(name);
	const candidates = [path.join(SAVED_DIR, safeName, "workflow.js"), path.join(BUNDLED_SAVED_DIR, safeName, "workflow.js")];
	return candidates.find((candidate) => fs.existsSync(candidate));
}

function newRunId(): string {
	return `wf-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(4).toString("hex")}`;
}

function monthKey(date = new Date()): string {
	return date.toISOString().slice(0, 7);
}

function findRunDir(runId: string): string | undefined {
	if (!fs.existsSync(RUNS_DIR)) return undefined;
	for (const month of fs.readdirSync(RUNS_DIR)) {
		const candidate = path.join(RUNS_DIR, month, runId);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

function createRunDir(runId: string): string {
	const dir = path.join(RUNS_DIR, monthKey(), runId);
	ensureDir(dir);
	ensureDir(path.join(dir, "checkpoints"));
	ensureDir(path.join(dir, "agents"));
	ensureDir(path.join(dir, "logs"));
	return dir;
}

function eventWriter(runDir: string, runId: string): (type: string, data?: Record<string, unknown>, level?: WorkflowEvent["level"]) => void {
	const eventsPath = path.join(runDir, "events.jsonl");
	let seq = 0;
	if (fs.existsSync(eventsPath)) {
		const last = fs.readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).at(-1);
		if (last) {
			try {
				const parsed = JSON.parse(last) as { seq?: unknown };
				if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) seq = parsed.seq;
			} catch {
				// Best effort only; event seq is diagnostic.
			}
		}
	}
	return (type, data, level = "info") => {
		const event: WorkflowEvent = {
			v: 1,
			seq: ++seq,
			ts: new Date().toISOString(),
			runId,
			type,
			level,
			...(data ? { data } : {}),
		};
		fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
	};
}

function appendWorkflowInbox(runDir: string, runId: string, input: { message: string; purpose?: string; source?: string }): { inboxPath: string; count: number } {
	const inboxPath = path.join(runDir, "inbox.jsonl");
	const existing = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, "utf-8").split("\n").filter((line) => line.trim()).length : 0;
	const entry = {
		v: 1,
		seq: existing + 1,
		ts: new Date().toISOString(),
		runId,
		purpose: input.purpose ?? "follow-up",
		message: input.message,
		source: input.source ?? "workflow_send",
	};
	fs.appendFileSync(inboxPath, `${JSON.stringify(entry)}\n`);
	fs.writeFileSync(path.join(runDir, "message.requested"), entry.ts);
	return { inboxPath, count: entry.seq };
}

function normalizeScriptSource(params: WorkflowParamsLike): { script: string; source: string } {
	const sources = [params.script, params.scriptPath, params.workflowName].filter((v) => typeof v === "string" && v.length > 0);
	if (sources.length !== 1) throw new Error("run requires exactly one of script, scriptPath, workflowName");
	if (params.script !== undefined) return { script: params.script, source: "inline" };
	if (params.scriptPath !== undefined) {
		const resolved = path.resolve(expandTilde(params.scriptPath));
		return { script: fs.readFileSync(resolved, "utf-8"), source: resolved };
	}
	const savedPath = workflowScriptPath(params.workflowName ?? "");
	if (!savedPath) throw new Error(`workflow not found: ${params.workflowName}`);
	return { script: fs.readFileSync(savedPath, "utf-8"), source: savedPath };
}

function toRunnableFunction(script: string): (api: Record<string, unknown>) => Promise<unknown> {
	const trimmed = script.trim();
	const match = trimmed.match(/^export\s+default\s+async\s+function\s*(?:\w+)?\s*\(/);
	if (match) {
		const source = trimmed.replace(/^export\s+default\s+/, "return ");
		return new Function("require", "process", "global", "globalThis", "Buffer", "fetch", `"use strict"; ${source}`)(undefined, undefined, undefined, {}, undefined, undefined) as (api: Record<string, unknown>) => Promise<unknown>;
	}
	const arrowMatch = trimmed.match(/^export\s+default\s+/);
	if (arrowMatch) {
		const source = trimmed.replace(/^export\s+default\s+/, "return ");
		return new Function("require", "process", "global", "globalThis", "Buffer", "fetch", `"use strict"; ${source}`)(undefined, undefined, undefined, {}, undefined, undefined) as (api: Record<string, unknown>) => Promise<unknown>;
	}
	throw new Error("workflow script must export default async function workflow(api) { ... }");
}

function contentText(result: AgentToolResult<Details>): string {
	const content = (result as any).content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n");
}

function agentNameOf(spec: AgentRunSpec): string {
	return typeof spec.agent === "string" ? spec.agent : spec.agent.name;
}

function subagentParamsFromSpec(spec: AgentRunSpec, cwd: string, defaultExtensionPolicy?: ChildExtensionPolicy): SubagentParamsLike {
  const specExtensions = spec.extensions ?? (typeof spec.agent === "object" ? spec.agent.extensions : undefined) ?? [];
  const basePolicy = spec.extensionPolicy ?? defaultExtensionPolicy ?? { mode: "isolated" as const };
  const extensionPolicy: ChildExtensionPolicy = {
    ...basePolicy,
    include: [...(basePolicy.include ?? []), ...specExtensions],
    exclude: basePolicy.exclude ?? [],
  };
  const params: Record<string, unknown> = {
		agent: agentNameOf(spec),
		task: spec.task,
		cwd: spec.cwd ?? cwd,
		context: spec.context,
		model: spec.model ?? (typeof spec.agent === "object" ? spec.agent.model : undefined),
		skill: spec.skills,
		outputSchema: spec.outputSchema,
		acceptance: spec.acceptance,
		async: spec.background === true ? true : undefined,
		timeoutMs: requestedSubagentTimeoutMs(spec),
		extensionPolicy,
		worktree: spec.writes === "worktree" ? true : (typeof spec.worktree === "boolean" ? spec.worktree : undefined),
	};
	return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)) as SubagentParamsLike;
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

export function createWorkflowExecutor(executeSubagent: ExecuteSubagent) {
  const activeRuns = activeWorkflowRuns();

  async function run(id: string, params: WorkflowParamsLike, signal: AbortSignal, _onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext): Promise<AgentToolResult<Details>> {
    ensureDir(SAVED_DIR);
    ensureDir(RUNS_DIR);
    if (params.action === "list") return listWorkflows();
    if (params.action === "status") return statusWorkflow(params.runId);
    if (params.action === "stop") return controlWorkflow(params.runId, params.message);
    if (params.action === "send") return sendWorkflow(params);
    if (params.action !== "run") throw new Error(`unsupported workflow action: ${params.action}`);

    const runId = params.runId ?? id ?? newRunId();
    const cwd = path.resolve(expandTilde(params.cwd ?? ctx.cwd ?? process.cwd()));
    const placement = params.placement ?? ((params as { async?: unknown }).async ? "background" : "background");
    const controller = new AbortController();
    if (signal.aborted) controller.abort();
    signal.addEventListener("abort", () => controller.abort(), { once: true });
    const runnerId = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const promise = executeWorkflowRun(runId, { ...params, placement }, controller.signal, ctx, cwd, runnerId)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`Workflow failed\nrunId: ${runId}\nerror: ${message}`, { mode: "workflow" as any, results: [] } as Details, true);
      })
      .finally(() => {
        activeRuns.delete(runId);
      });
    activeRuns.set(runId, { promise, runnerId, startedAt: Date.now() });
    if (placement === "foreground") return promise;
    const runDir = findRunDir(runId) ?? path.join(RUNS_DIR, monthKey(), runId);
    return textResult(`Workflow started\nrunId: ${runId}\nrunDir: ${runDir}\nInspect: workflow_status({ id: "${runId}" })\nSend: workflow_send({ id: "${runId}", input: "..." })\nStop: workflow_stop({ id: "${runId}", reason: "..." })`, { mode: "workflow" as any, results: [] } as Details);
  }

  async function executeWorkflowRun(runId: string, params: WorkflowParamsLike, signal: AbortSignal, ctx: ExtensionContext, cwd: string, runnerId: string): Promise<AgentToolResult<Details>> {
    const runDir = createRunDir(runId);
    const emit = eventWriter(runDir, runId);
    const { script, source } = normalizeScriptSource(params);
    const scriptPath = path.join(runDir, "workflow.js");
    const argsPath = path.join(runDir, "args.json");
    fs.writeFileSync(scriptPath, script);
    writeJson(argsPath, params.args ?? {});
    const startedAt = new Date().toISOString();
    const state: WorkflowRunState = {
      runId,
      status: "running",
      createdAt: startedAt,
      updatedAt: startedAt,
      cwd,
      scriptPath,
      argsPath,
      eventsPath: path.join(runDir, "events.jsonl"),
      agentCount: 0,
      inboxPath: path.join(runDir, "inbox.jsonl"),
      runnerId,
      runnerPid: process.pid,
      runnerHeartbeatAt: startedAt,
    };
    writeJson(path.join(runDir, "manifest.json"), { runId, source, cwd, args: params.args ?? {}, limits: params.limits ?? {}, writes: params.writes ?? "none", mode: params.placement ?? "background", createdAt: startedAt });
    writeJson(path.join(runDir, "status.json"), state);
    emit("run.created", { source, cwd });
    emit("worker.started", { mode: params.placement ?? "background" });
    const statusPath = path.join(runDir, "status.json");
    const heartbeat = setInterval(() => {
      if (state.status !== "running" && state.status !== "paused") return;
      state.runnerHeartbeatAt = new Date().toISOString();
      state.updatedAt = state.runnerHeartbeatAt;
      try { writeJson(statusPath, state); } catch { /* best effort heartbeat */ }
    }, WORKFLOW_HEARTBEAT_MS);
    heartbeat.unref?.();

    const maxAgents = params.limits?.maxAgents ?? 64;
    const concurrency = params.limits?.concurrency ?? 4;
    const deadline = params.limits?.maxRuntimeMs ? Date.now() + params.limits.maxRuntimeMs : undefined;

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const markerTime = (name: string) => {
      const file = path.join(runDir, `${name}.requested`);
      return fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
    };
    const checkControl = async () => {
      if (signal.aborted || markerTime("stop") > 0) throw new WorkflowStopError();
      if (deadline && Date.now() > deadline) throw new Error("workflow maxRuntimeMs exceeded");
      const pauseAt = markerTime("pause");
      if (!pauseAt || markerTime("resume") > pauseAt) return;
      state.status = "paused";
      state.updatedAt = new Date().toISOString();
      writeJson(statusPath, state);
      emit("workflow.paused");
      while (!signal.aborted && markerTime("stop") === 0 && markerTime("resume") <= pauseAt) await sleep(1000);
      if (signal.aborted || markerTime("stop") > 0) throw new WorkflowStopError();
      state.status = "running";
      state.updatedAt = new Date().toISOString();
      writeJson(statusPath, state);
      emit("workflow.resumed");
    };

    const runAgent = async (spec: AgentRunSpec): Promise<AgentResult> => {
      await checkControl();
      state.agentCount++;
      if (state.agentCount > maxAgents) throw new Error(`workflow maxAgents exceeded: ${maxAgents}`);
      const agentRunId = `${runId}-agent-${state.agentCount}`;
      const nodeDir = path.join(runDir, "agents", agentRunId);
      ensureDir(nodeDir);
      writeJson(path.join(nodeDir, "spec.json"), spec);
      emit("agent.started", { agent: agentNameOf(spec), agentRunId });
      const result = await executeSubagent(agentRunId, subagentParamsFromSpec(spec, cwd, params.extensionPolicy), signal, undefined, ctx);
      const output = contentText(result);
      const details = (result as any).details ?? {};
      const backgroundRequested = spec.background === true;
      const asyncId = typeof details.asyncId === "string" ? details.asyncId : undefined;
      const asyncDir = typeof details.asyncDir === "string" ? details.asyncDir : undefined;
      const agentResult: AgentResult = {
        id: agentRunId,
        agent: agentNameOf(spec),
        status: (result as any).isError ? "failed" : backgroundRequested ? "running" : "completed",
        output,
        ...(asyncId ? { asyncId } : {}),
        ...(asyncDir ? { asyncDir } : {}),
        ...(result as any).isError ? { error: output } : {},
        artifacts: {
          output: path.join(nodeDir, "output.txt"),
          result: path.join(nodeDir, "result.json"),
          ...(asyncDir ? { asyncDir } : {}),
        },
        raw: details,
      };
      fs.writeFileSync(path.join(nodeDir, "output.txt"), output);
      writeJson(path.join(nodeDir, "result.json"), agentResult);
      emit(agentResult.status === "completed" ? "agent.completed" : agentResult.status === "running" ? "agent.background.started" : "agent.failed", { agent: agentResult.agent, agentRunId, asyncId: agentResult.asyncId, asyncDir: agentResult.asyncDir });
      await checkControl();
      return agentResult;
    };

    const readInbox = (sinceSeq = 0) => {
		const inboxPath = path.join(runDir, "inbox.jsonl");
		if (!fs.existsSync(inboxPath)) return [];
		return fs.readFileSync(inboxPath, "utf-8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as { seq: number; ts: string; purpose: string; message: string })
			.filter((entry) => entry.seq > sinceSeq);
	};

	const waitForInbox = async (sinceSeq = 0, options?: { timeoutMs?: number }) => {
		const deadlineAt = options?.timeoutMs ? Date.now() + options.timeoutMs : undefined;
		while (true) {
			await checkControl();
			const entries = readInbox(sinceSeq);
			if (entries.length > 0) return entries;
			if (deadlineAt && Date.now() >= deadlineAt) return [];
			await sleep(500);
		}
	};

    const api = {
      args: params.args ?? {},
      limits: { maxAgents, concurrency, maxRuntimeMs: params.limits?.maxRuntimeMs },
      log: async (message: string, data?: unknown) => { await checkControl(); emit("workflow.log", { message, data }); },
      progress: async (label: string, data?: unknown) => { await checkControl(); emit("workflow.progress", { label, data }); },
      checkpoint: async (name: string, value: unknown) => {
        await checkControl();
        const safeName = sanitizeName(name);
        const checkpointPath = path.join(runDir, "checkpoints", `${safeName}.json`);
        writeJson(checkpointPath, value);
        writeJson(path.join(runDir, "checkpoints", "latest.json"), { name: safeName, path: checkpointPath, value });
        emit("checkpoint.written", { name: safeName, path: checkpointPath });
      },
      agent: {
        run: runAgent,
        background: async (spec: AgentRunSpec) => runAgent({ ...spec, background: true }),
        parallel: async (specs: AgentRunSpec[], options?: { concurrency?: number }) => {
          await checkControl();
          const c = Math.max(1, Math.min(options?.concurrency ?? concurrency, concurrency));
          return mapConcurrent(specs, c, (spec) => runAgent(spec));
        },
        map: async <T>(items: T[], options: { concurrency?: number; task(item: T, index: number): AgentRunSpec }) => {
          await checkControl();
          if (items.length > maxAgents) throw new Error(`workflow map item count exceeds maxAgents: ${maxAgents}`);
          const c = Math.max(1, Math.min(options.concurrency ?? concurrency, concurrency));
          return mapConcurrent(items, c, (item, index) => runAgent(options.task(item, index)));
        },
      },
      inbox: {
		read: readInbox,
		wait: waitForInbox,
	  },
    };

    try {
      const fn = toRunnableFunction(script);
      const finalValue = await fn(api);
      await checkControl();
      const finalJsonPath = path.join(runDir, "final.json");
      const finalPath = path.join(runDir, "final.md");
      writeJson(finalJsonPath, finalValue ?? null);
      fs.writeFileSync(finalPath, typeof finalValue === "string" ? finalValue : `${JSON.stringify(finalValue, null, 2)}\n`);
      state.status = "completed";
      state.updatedAt = new Date().toISOString();
      state.finalPath = finalPath;
      state.finalJsonPath = finalJsonPath;
      clearInterval(heartbeat);
      writeJson(statusPath, state);
      emit("workflow.completed", { finalPath, finalJsonPath });
      return textResult(`Workflow completed\nrunId: ${runId}\nrunDir: ${runDir}\nfinal: ${finalPath}`, { mode: "workflow" as any, results: [] } as Details);
    } catch (error) {
      const stopped = error instanceof WorkflowStopError || signal.aborted;
      const message = stopped ? "workflow stopped" : (error instanceof Error ? error.message : String(error));
      state.status = stopped ? "stopped" : "failed";
      state.error = message;
      state.updatedAt = new Date().toISOString();
      clearInterval(heartbeat);
      writeJson(statusPath, state);
      emit(stopped ? "workflow.stopped" : "workflow.failed", { error: message }, stopped ? "warn" : "error");
      return textResult(`${stopped ? "Workflow stopped" : "Workflow failed"}\nrunId: ${runId}\nrunDir: ${runDir}\n${stopped ? "" : `error: ${message}`}`, { mode: "workflow" as any, results: [] } as Details, !stopped);
    }
  }

  return { run };
}

function textResult(text: string, details: Details, isError = false): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], details, ...(isError ? { isError: true } : {}) } as AgentToolResult<Details>;
}

function listWorkflows(): AgentToolResult<Details> {
	ensureDir(SAVED_DIR);
	ensureDir(RUNS_DIR);
	const saved = [...new Set([
		...(fs.existsSync(SAVED_DIR) ? fs.readdirSync(SAVED_DIR) : []),
		...(fs.existsSync(BUNDLED_SAVED_DIR) ? fs.readdirSync(BUNDLED_SAVED_DIR) : []),
	])].filter((name) => workflowScriptPath(name));
	const runs: string[] = [];
	for (const month of fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR) : []) {
		const monthDir = path.join(RUNS_DIR, month);
		if (!fs.statSync(monthDir).isDirectory()) continue;
		for (const runId of fs.readdirSync(monthDir)) runs.push(`${month}/${runId}`);
	}
	return textResult(["Saved workflows:", ...saved.map((name) => `- ${name}`), "", "Recent runs:", ...runs.slice(-20).map((run) => `- ${run}`)].join("\n"), { mode: "workflow" as any, results: [] } as Details);
}

function reconcileWorkflowStatus(runDir: string, status: Record<string, unknown>, action: "status" | "stop", reason?: string): Record<string, unknown> {
	const runId = typeof status.runId === "string" ? status.runId : path.basename(runDir);
	const state = status.status;
	if (state !== "running" && state !== "paused") return status;
	if (activeWorkflowRuns().has(runId)) return status;
	const heartbeatAt = typeof status.runnerHeartbeatAt === "string" ? Date.parse(status.runnerHeartbeatAt) : NaN;
	const heartbeatStale = !Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > WORKFLOW_STALE_MS;
	if (!heartbeatStale && action !== "stop") return status;
	const next = {
		...status,
		status: action === "stop" ? "stopped" : "paused",
		updatedAt: new Date().toISOString(),
		orphanedReason: action === "stop"
			? `Workflow stop requested but no active workflow runner was attached in this Pi runtime.${reason ? ` Reason: ${reason}` : ""}`
			: "Workflow runner heartbeat is stale and no active workflow runner is attached in this Pi runtime. The run was marked paused to avoid a false running state.",
	};
	writeJson(path.join(runDir, "status.json"), next);
	const emit = eventWriter(runDir, runId);
	emit(action === "stop" ? "workflow.stopped" : "workflow.orphaned", { reason: next.orphanedReason }, action === "stop" ? "warn" : "error");
	return next;
}

function statusWorkflow(runId: string | undefined): AgentToolResult<Details> {
	if (!runId) throw new Error("status requires runId");
	const runDir = findRunDir(runId);
	if (!runDir) throw new Error(`workflow run not found: ${runId}`);
	const statusPath = path.join(runDir, "status.json");
	const rawStatus = fs.existsSync(statusPath) ? readJson<Record<string, unknown>>(statusPath) : { runId, status: "unknown" };
	const status = reconcileWorkflowStatus(runDir, rawStatus, "status");
	const eventsPath = path.join(runDir, "events.jsonl");
	const tail = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8").trim().split("\n").slice(-20).join("\n") : "";
	return textResult(`Workflow status\nrunDir: ${runDir}\ninbox: ${path.join(runDir, "inbox.jsonl")}\n\n${JSON.stringify(status, null, 2)}\n\nEvents tail:\n${tail}`, { mode: "workflow" as any, results: [] } as Details);
}

function controlWorkflow(runId: string | undefined, reason?: string): AgentToolResult<Details> {
	if (!runId) throw new Error("stop requires runId");
	const runDir = findRunDir(runId);
	if (!runDir) throw new Error(`workflow run not found: ${runId}`);
	const marker = path.join(runDir, "stop.requested");
	fs.writeFileSync(marker, reason ? `${new Date().toISOString()}\n${reason}\n` : new Date().toISOString());
	const statusPath = path.join(runDir, "status.json");
	if (fs.existsSync(statusPath)) {
		const status = reconcileWorkflowStatus(runDir, readJson<Record<string, unknown>>(statusPath), "stop", reason);
		if (status.status === "stopped" && !activeWorkflowRuns().has(runId)) return textResult(`Workflow stopped\nrunId: ${runId}\nmarker: ${marker}${reason ? `\nreason: ${reason}` : ""}\nNote: no active workflow runner was attached; persisted status was closed.`, { mode: "workflow" as any, results: [] } as Details);
	}
	return textResult(`Workflow stop requested\nrunId: ${runId}\nmarker: ${marker}${reason ? `\nreason: ${reason}` : ""}`, { mode: "workflow" as any, results: [] } as Details);
}

function sendWorkflow(params: WorkflowParamsLike): AgentToolResult<Details> {
	if (!params.runId) throw new Error("send requires runId");
	if (!params.message?.trim()) throw new Error("send requires message");
	const runDir = findRunDir(params.runId);
	if (!runDir) throw new Error(`workflow run not found: ${params.runId}`);
	const { inboxPath, count } = appendWorkflowInbox(runDir, params.runId, { message: params.message.trim(), purpose: params.purpose });
	return textResult(`Workflow message queued\nrunId: ${params.runId}\ninbox: ${inboxPath}\nseq: ${count}`, { mode: "workflow" as any, results: [] } as Details);
}
