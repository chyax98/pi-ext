/** tmux_process — unified tmux-backed background process control. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  sessionExists,
  createSession,
  windowExists,
  newWindow,
  setMonitorSilence,
  pipePane,
  isPaneDead,
  getPanePid,
  capturePane,
  killWindow,
} from "../lib/tmux.js";
import {
  writeState,
  logsDir,
  isProcessRunning,
  readProcessExitCode,
  readProcessPid,
  reconcileState,
} from "../lib/state.js";
import type { OrchestratorState, ProcessEntry } from "../lib/state.js";
import { readLog } from "../lib/log.js";
import { formatList, resolveEntry, type ListResult } from "../lib/tool-helpers.js";

type ProcessSpec = {
  command: string;
  name: string;
  cwd?: string;
  silenceTimeoutSec?: number;
};

type UnifiedAction = "run" | "list" | "logs" | "stop";

export function registerTmuxProcess(
  pi: ExtensionAPI,
  getState: () => OrchestratorState | null,
  setState: (state: OrchestratorState) => void,
) {
  pi.registerTool({
    name: "tmux_process",
    label: "Tmux Background Processes",
    description: "Unified tmux process operation. Always pass processes:[{name,command?,cwd?}] for process-scoped actions; action selects run, list, logs, or stop.",
    promptSnippet: "Operate managed tmux background processes",
    promptGuidelines: [
      "Prefer this tool only for long-running foreground commands such as dev servers, watchers, tails, or eval runners.",
      "Use one consistent shape: processes:[{name,command?,cwd?}] for run/logs/stop; use a one-element array for a single process.",
      "Use action:'logs' before stopping a process unless the user explicitly asked to stop immediately.",
      "Use action:'stop' with stopMode:'process' to terminate but keep logs/window; use stopMode:'window' for full cleanup.",
      "Use safe names matching /^[A-Za-z0-9._-]+$/; avoid ':', '/', spaces, and shell metacharacters.",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "run | list | logs | stop. Default: run" })),
      processes: Type.Optional(Type.Array(Type.Object({
        command: Type.Optional(Type.String({ description: "Shell command to run. Required for action:'run'; ignored for logs/stop." })),
        name: Type.String({ description: "Unique tmux window/process name" }),
        cwd: Type.Optional(Type.String({ description: "Working directory; defaults to project cwd" })),
        silenceTimeoutSec: Type.Optional(Type.Number({ description: "Notify if no output for this many seconds (default: 30, 0 to disable)", minimum: 0 })),
      }))),
      lines: Type.Optional(Type.Number({ description: "Recent log lines for action:'logs' (default: 50, max: 200)", minimum: 1, maximum: 200 })),
      stopMode: Type.Optional(Type.String({ description: "For action:'stop': process | window. Default: process" })),
      signal: Type.Optional(Type.String({ description: "For action:'stop' with stopMode:'process': SIGTERM | SIGKILL. Default: SIGTERM" })),
      reason: Type.Optional(Type.String({ description: "Why stopping/cleaning up; required by policy for action:'stop'" })),
    }),
    async execute(_id, params) {
      const state = getState();
      if (!state) return err("Process manager not initialized");

      const action = normalizeAction(params.action);
      if (action === "list") return listProcesses(state, setState);
      if (action === "logs") return logsProcesses(state, params.processes, params.lines);
      if (action === "stop") return stopProcesses(state, setState, params.processes, params.stopMode, params.signal, params.reason);

      const specs = resolveRunSpecs(params, state.projectPath);
      if (specs.length === 0) return err("action:'run' requires processes:[{name,command,cwd}]. Use the same one-element array shape for a single process.");

      const results: Array<{ name: string; ok: boolean; text: string; details?: unknown }> = [];
      let currentState = state;
      for (const spec of specs) {
        const started = startOneProcess(pi, getState, currentState, setState, spec);
        results.push(started);
        const latest = getState();
        if (latest) currentState = latest;
      }

      const failures = results.filter((result) => !result.ok);
      return {
        content: [{
          type: "text" as const,
          text: [
            `tmux_process action=run: ${results.length - failures.length}/${results.length} started`,
            ...results.map((result) => `- ${result.ok ? "OK" : "ERROR"} ${result.name}: ${result.text}`),
          ].join("\n"),
        }],
        details: { action: "run", results },
        isError: failures.length > 0,
      };
    },
  });
}

const WATCHERS_KEY = Symbol.for("pi-tmux-process-manager.processWatchers");
const watchedProcesses: Map<string, ReturnType<typeof setInterval>> =
  ((globalThis as any)[WATCHERS_KEY] ??= new Map<string, ReturnType<typeof setInterval>>());

export function cancelProcessWatch(sessionName: string, processName: string): void {
  const key = `${sessionName}:${processName}`;
  const timer = watchedProcesses.get(key);
  if (timer) clearInterval(timer);
  watchedProcesses.delete(key);
}

export function resumeProcessWatches(
  pi: ExtensionAPI,
  getState: () => OrchestratorState | null,
  setState: (state: OrchestratorState) => void,
): void {
  const state = getState();
  if (!state) return;
  for (const entry of Object.values(state.entries)) ensureProcessWatch(pi, getState, setState, entry);
}

function normalizeAction(input: unknown): UnifiedAction {
  if (input === "list") return "list";
  if (input === "logs" || input === "log" || input === "tail") return "logs";
  if (input === "stop" || input === "kill" || input === "close") return "stop";
  return "run";
}

function resolveRunSpecs(params: any, defaultCwd: string): ProcessSpec[] {
  if (!Array.isArray(params.processes) || params.processes.length === 0) return [];
  return params.processes.map((item: any) => ({
    command: typeof item.command === "string" ? item.command : "",
    name: item.name,
    cwd: item.cwd ?? defaultCwd,
    silenceTimeoutSec: item.silenceTimeoutSec,
  }));
}

function startOneProcess(
  pi: ExtensionAPI,
  getState: () => OrchestratorState | null,
  state: OrchestratorState,
  setState: (state: OrchestratorState) => void,
  spec: ProcessSpec,
): { name: string; ok: boolean; text: string; details?: unknown } {
  const cwd = spec.cwd ?? state.projectPath;
  const silenceTimeout = spec.silenceTimeoutSec ?? 30;
  if (!spec.command.trim()) {
    return { name: spec.name, ok: false, text: "action:'run' requires command in each processes item." };
  }
  if (!isSafeProcessName(spec.name)) {
    return { name: spec.name, ok: false, text: "Process name must match /^[A-Za-z0-9._-]+$/." };
  }
  if (!sessionExists(state.sessionName)) createSession(state.sessionName, cwd);
  if (windowExists(state.sessionName, spec.name)) {
    return { name: spec.name, ok: false, text: "Window already exists. Use action:'stop' first or choose another name." };
  }

  const dir = logsDir(state.projectPath, state.sessionKey);
  fs.mkdirSync(dir, { recursive: true });
  const runId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const baseName = `proc-${spec.name}-${runId}`;
  const logPath = path.join(dir, `${baseName}.log`);
  const statusPath = path.join(dir, `${baseName}.exit`);
  const pidPath = path.join(dir, `${baseName}.pid`);
  const scriptPath = path.join(dir, `${baseName}.sh`);
  fs.writeFileSync(logPath, `--- process ${spec.name} run ${runId} started at ${new Date().toISOString()} ---\n`);

  const script = [
    "#!/usr/bin/env bash",
    "set +e",
    `rm -f ${shellQuote(statusPath)} ${shellQuote(pidPath)}`,
    `if command -v setsid >/dev/null 2>&1; then setsid bash -lc ${shellQuote(spec.command)} & else bash -lc ${shellQuote(spec.command)} & fi`,
    "child=$!",
    `printf '%s\\n' "$child" > ${shellQuote(pidPath)}`,
    "wait \"$child\"",
    "ec=$?",
    "printf '\\n[process_exit:%s]\\n' \"$ec\"",
    `printf '%s\\n' "$ec" > ${shellQuote(statusPath)}`,
    `rm -f ${shellQuote(pidPath)}`,
    "echo '[process_stopped_keep_window_open]'",
    "tail -f /dev/null",
    "",
  ].join("\n");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });

  const ok = newWindow(state.sessionName, spec.name, `bash ${shellQuote(scriptPath)}`, cwd);
  if (!ok) return { name: spec.name, ok: false, text: "Failed to create tmux window." };

  pipePane(state.sessionName, spec.name, logPath);
  if (silenceTimeout > 0) setMonitorSilence(state.sessionName, spec.name, silenceTimeout);

  const entry: ProcessEntry = {
    type: "process",
    name: spec.name,
    command: spec.command,
    cwd,
    startedAt: Date.now(),
    logPath,
    statusPath,
    pidPath,
    runId,
    panePid: getPanePid(state.sessionName, spec.name),
    silenceTimeoutSec: silenceTimeout,
  };
  const nextState = { ...state, entries: { ...state.entries, [spec.name]: entry } };
  writeState(nextState);
  setState(nextState);
  ensureProcessWatch(pi, getState, setState, entry);

  return {
    name: spec.name,
    ok: true,
    text: `Started. Cwd: ${cwd}. Log: ${logPath}. Use action:'logs', processes:[{name:'${spec.name}'}] to inspect output.`,
    details: { name: spec.name, cwd, logPath, statusPath, pidPath, runId },
  };
}

function listProcesses(state: OrchestratorState, setState: (state: OrchestratorState) => void) {
  const reconciled = reconcileState(state);
  setState(reconciled);
  writeState(reconciled);
  const result: ListResult = {
    processes: Object.values(reconciled.entries).map((entry) => ({
      name: entry.name,
      command: entry.command,
      alive: isProcessRunning(entry),
      cwd: entry.cwd,
      startedAt: new Date(entry.startedAt).toISOString(),
      exitCode: readProcessExitCode(entry),
    })),
  };
  return { content: [{ type: "text" as const, text: formatList(result) }], details: { action: "list", ...result } };
}

function logsProcesses(state: OrchestratorState, processes?: Array<{ name?: string }>, lines?: number) {
  const names = normalizeProcessNames(processes);
  if (names.length === 0) return err("action:'logs' requires processes:[{name}].");
  const blocks = names.map((name) => formatLogsForTarget(state, name, lines));
  const failures = blocks.filter((block) => !block.ok);
  return {
    content: [{ type: "text" as const, text: blocks.map((block) => block.text).join("\n\n---\n\n") }],
    details: { action: "logs", results: blocks },
    isError: failures.length > 0,
  };
}

function formatLogsForTarget(state: OrchestratorState, target: string, linesInput?: number) {
  const entry = resolveEntry(state, target);
  if (!entry) return { target, ok: false, text: `Error: Process '${target}' not found.` };
  const lines = Math.min(linesInput ?? 50, 200);
  const processRunning = isProcessRunning(entry);
  const windowAlive = !isPaneDead(state.sessionName, entry.name);
  const exitCode = readProcessExitCode(entry);
  let lastOutputSec: number | null = null;
  if (entry.logPath) {
    try {
      const stat = fs.statSync(entry.logPath);
      lastOutputSec = Math.round((Date.now() - stat.mtimeMs) / 1000);
    } catch {
      // log file may not exist yet
    }
  }

  let output = capturePane(state.sessionName, entry.name, lines);
  let fromLog = false;
  if (!output && entry.logPath) {
    const logContent = readLog(entry.logPath);
    if (logContent) {
      output = logContent.split("\n").slice(-lines).join("\n");
      fromLog = true;
    }
  }

  const header = [
    `### Process: ${entry.name}`,
    `Process status: ${processRunning ? "🟢 running" : "⚫ stopped"}`,
    `Window status: ${windowAlive ? "🟢 present" : "⚫ closed"}`,
    exitCode !== null ? `Last exit code: ${exitCode}` : null,
    lastOutputSec !== null ? `Last output: ${lastOutputSec}s ago` : null,
  ].filter(Boolean).join("\n");

  if (!output) {
    return {
      target,
      ok: true,
      text: `${header}\n${processRunning ? "No output yet — process may still be starting." : "No output captured."}`,
      details: { processName: entry.name, lines, output: "", processRunning, windowAlive, lastOutputSec, exitCode },
    };
  }

  const maxChars = 8_000;
  const truncated = output.length > maxChars;
  const finalOutput = truncated ? output.slice(-maxChars) : output;
  return {
    target,
    ok: true,
    text: [header, "```", finalOutput, "```", fromLog ? "_[from log file]_" : null].filter(Boolean).join("\n"),
    details: { processName: entry.name, lines, truncated, charCount: output.length, processRunning, windowAlive, lastOutputSec, exitCode },
  };
}

function stopProcesses(
  state: OrchestratorState,
  setState: (state: OrchestratorState) => void,
  processes?: Array<{ name?: string }>,
  stopModeInput?: string,
  signalInput?: string,
  reason?: string,
) {
  const names = normalizeProcessNames(processes);
  if (names.length === 0) return err("action:'stop' requires processes:[{name}].");
  if (!reason) return err("action:'stop' requires reason.");
  const stopMode = stopModeInput === "window" ? "window" : "process";
  const signal = signalInput === "SIGKILL" ? "SIGKILL" : "SIGTERM";

  let currentState = state;
  const results = names.map((name) => {
    const result = stopOne(currentState, setState, name, stopMode, signal, reason);
    const next = result.nextState;
    if (next) currentState = next;
    return result;
  });
  const failures = results.filter((result) => !result.ok);
  return {
    content: [{ type: "text" as const, text: results.map((result) => `- ${result.ok ? "OK" : "ERROR"} ${result.target}: ${result.text}`).join("\n") }],
    details: { action: "stop", results: results.map(({ nextState: _nextState, ...result }) => result) },
    isError: failures.length > 0,
  };
}

function stopOne(
  state: OrchestratorState,
  setState: (state: OrchestratorState) => void,
  target: string,
  stopMode: "process" | "window",
  signal: "SIGTERM" | "SIGKILL",
  reason: string,
): { target: string; ok: boolean; text: string; nextState?: OrchestratorState } {
  const entry = resolveEntry(state, target);
  if (!entry) return { target, ok: false, text: "Process not found in state. It may have already exited." };

  if (stopMode === "process") {
    const pid = readProcessPid(entry);
    if (!pid) return { target, ok: false, text: "Process is not currently running. Use stopMode:'window' to close the tmux window." };
    let ok = false;
    try {
      process.kill(-pid, signal);
      ok = true;
    } catch {
      try {
        process.kill(pid, signal);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) return { target, ok: false, text: `Failed to send ${signal}. It may have already exited.` };
    return { target, ok: true, text: `Sent ${signal}. Tmux window kept open for logs. Reason: ${reason}` };
  }

  cancelProcessWatch(state.sessionName, entry.name);
  const ok = killWindow(state.sessionName, entry.name);
  const nextState = { ...state, entries: { ...state.entries } };
  delete nextState.entries[entry.name];
  setState(nextState);
  writeState(nextState);
  return {
    target,
    ok: true,
    text: ok ? `Closed tmux window. Reason: ${reason}` : "Tmux window may already be gone. State cleaned up.",
    nextState,
  };
}

function normalizeProcessNames(processes?: Array<{ name?: string }>): string[] {
  const result = new Set<string>();
  for (const item of processes ?? []) if (item?.name) result.add(item.name);
  return [...result];
}

function ensureProcessWatch(
  pi: ExtensionAPI,
  getState: () => OrchestratorState | null,
  setState: (state: OrchestratorState) => void,
  entry: ProcessEntry,
): void {
  const state = getState();
  if (!state) return;
  const key = `${state.sessionName}:${entry.name}`;
  if (watchedProcesses.has(key)) return;

  let notifiedStopped = false;
  const timer = setInterval(() => {
    const current = getState();
    if (!current) return;
    const currentEntry = current.entries[entry.name];
    if (!currentEntry) {
      clearInterval(timer);
      watchedProcesses.delete(key);
      return;
    }

    const running = isProcessRunning(currentEntry);
    const exitCode = readProcessExitCode(currentEntry);
    if (!running && exitCode !== null && !notifiedStopped) {
      notifiedStopped = true;
      try {
        pi.sendMessage({
          customType: "tmux-process-stopped",
          display: true,
          content: [
            `Background process stopped: **${currentEntry.name}**`,
            `Command: ${currentEntry.command}`,
            `Exit code: ${exitCode}`,
            `Window kept open for logs. Use tmux_process({ action: "logs", processes: [{ name: "${currentEntry.name}" }] }) or tmux_process({ action: "stop", processes: [{ name: "${currentEntry.name}" }], stopMode: "window", reason: "cleanup" }).`,
          ].join("\n"),
        }, { triggerTurn: true });
      } catch {
        // Best effort only.
      }
    }

    if (!isPaneDead(current.sessionName, currentEntry.name)) return;

    clearInterval(timer);
    watchedProcesses.delete(key);

    const nextEntries = { ...current.entries };
    delete nextEntries[currentEntry.name];
    const nextState = { ...current, entries: nextEntries };
    setState(nextState);
    writeState(nextState);
  }, 1_000);
  timer.unref?.();
  watchedProcesses.set(key, timer);
}

function isSafeProcessName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: {}, isError: true };
}
