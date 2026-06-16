/**
 * Persisted state for tmux-backed background processes.
 * tmux stores the visible container; state stores process metadata.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { listWindowsSafe } from "./tmux.js";

export interface ProcessEntry {
  type: "process";
  name: string;
  command: string;
  cwd: string;
  startedAt: number;
  logPath?: string;
  statusPath?: string;
  pidPath?: string;
  runId?: string;
  panePid?: number | null;
  silenceTimeoutSec: number;
}

export const STATE_VERSION = 5;

export interface OrchestratorState {
  version: typeof STATE_VERSION;
  sessionName: string;
  supervisorPid: number;
  cwdHash: string;
  /** Stable per Pi conversation. Prevents same-cwd Pi instances from sharing tmux state. */
  sessionKey: string;
  projectPath: string;
  entries: Record<string, ProcessEntry>;
}

export interface LockInfo {
  cwdHash: string;
  sessionKey: string;
  supervisorPid: number;
  startedAt: number;
}

export function cwdHash(cwd: string): string {
  return crypto.createHash("md5").update(cwd).digest("hex").slice(0, 8);
}

export function sessionHash(sessionId: string | null | undefined): string {
  if (!sessionId) return "cwd";
  return crypto.createHash("md5").update(sessionId).digest("hex").slice(0, 8);
}

export function stateDir(cwd: string, sessionKey = "cwd"): string {
  const base = path.join(process.env.HOME ?? "/tmp", ".pi", "tmux-process-manager", cwdHash(cwd));
  return sessionKey === "cwd" ? base : path.join(base, sessionKey);
}

export function statePath(cwd: string, sessionKey = "cwd"): string {
  return path.join(stateDir(cwd, sessionKey), "state.json");
}

export function lockPath(cwd: string, sessionKey = "cwd"): string {
  return path.join(stateDir(cwd, sessionKey), "supervisor.lock");
}

export function logsDir(cwd: string, sessionKey = "cwd"): string {
  return path.join(stateDir(cwd, sessionKey), "logs");
}

export function readState(cwd: string, sessionKey = "cwd"): OrchestratorState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(cwd, sessionKey), "utf8")) as OrchestratorState;
  } catch {
    return null;
  }
}

export function writeState(state: OrchestratorState): void {
  const target = statePath(state.projectPath, state.sessionKey);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  try {
    fs.renameSync(tmp, target);
  } catch (error: any) {
    if (error?.code === "EXDEV") {
      fs.writeFileSync(target, JSON.stringify(state, null, 2), "utf8");
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      return;
    }
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

export function initState(cwd: string, sessionName: string, sessionKey = "cwd"): OrchestratorState {
  const state: OrchestratorState = {
    version: STATE_VERSION,
    sessionName,
    supervisorPid: process.pid,
    cwdHash: cwdHash(cwd),
    sessionKey,
    projectPath: cwd,
    entries: {},
  };
  fs.mkdirSync(stateDir(cwd, sessionKey), { recursive: true });
  fs.mkdirSync(logsDir(cwd, sessionKey), { recursive: true });
  writeState(state);
  return state;
}

export function reconcileState(state: OrchestratorState): OrchestratorState {
  const tmuxWindows = listWindowsSafe(state.sessionName);
  if (tmuxWindows === null) return state;

  const liveWindowNames = new Set(tmuxWindows.map((window) => window.name));
  const entries: Record<string, ProcessEntry> = {};
  for (const [key, entry] of Object.entries(state.entries)) {
    if (liveWindowNames.has(entry.name)) entries[key] = entry;
  }
  return { ...state, entries };
}

export function readLock(cwd: string, sessionKey = "cwd"): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath(cwd, sessionKey), "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

export function writeLock(cwd: string, info: LockInfo): void {
  fs.mkdirSync(stateDir(cwd, info.sessionKey), { recursive: true });
  fs.writeFileSync(lockPath(cwd, info.sessionKey), JSON.stringify(info, null, 2), "utf8");
}

export function clearLock(cwd: string, sessionKey = "cwd"): void {
  try { fs.unlinkSync(lockPath(cwd, sessionKey)); } catch { /* already gone */ }
}

export function isLockActive(lock: LockInfo): boolean {
  try {
    process.kill(lock.supervisorPid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readProcessPid(entry: ProcessEntry): number | null {
  if (!entry.pidPath) return null;
  try {
    const raw = fs.readFileSync(entry.pidPath, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function readProcessExitCode(entry: ProcessEntry): number | null {
  if (!entry.statusPath) return null;
  try {
    const raw = fs.readFileSync(entry.statusPath, "utf8").trim();
    const code = Number.parseInt(raw, 10);
    return Number.isNaN(code) ? null : code;
  } catch {
    return null;
  }
}

export function isProcessRunning(entry: ProcessEntry): boolean {
  const pid = readProcessPid(entry);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
