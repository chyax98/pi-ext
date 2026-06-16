/**
 * pi-tmux-process-manager — tmux-backed background process manager for Pi.
 *
 * Scope:
 *   - start long-running processes in tmux windows
 *   - list tracked processes
 *   - read logs/output
 *   - stop a process or close its tmux window
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTmuxProcess, resumeProcessWatches } from "./tools/tmux-process.js";
import { getTmuxVersion, sessionExists, createSession, killSession } from "./lib/tmux.js";
import {
  initState,
  readState,
  reconcileState,
  writeState,
  writeLock,
  readLock,
  isLockActive,
  clearLock,
  cwdHash,
  sessionHash,
  STATE_VERSION,
} from "./lib/state.js";
import type { OrchestratorState } from "./lib/state.js";

export default async function piTmuxProcessManager(pi: ExtensionAPI) {
  let state: OrchestratorState | null = null;
  const getState = () => state;
  const setState = (nextState: OrchestratorState) => { state = nextState; };

  registerTmuxProcess(pi, getState, setState);

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    const piSessionId = getPiSessionIdFromContext(ctx);
    const hash = cwdHash(cwd);
    const sessionKey = sessionHash(piSessionId);

    const version = getTmuxVersion();
    if (!version || version < 3.2) {
      ctx.ui.notify(
        `pi-tmux-process-manager requires tmux >= 3.2 (found: ${version ?? "none"}). Install: brew install tmux`,
        "error",
      );
      return;
    }

    const lock = readLock(cwd, sessionKey);
    if (lock && isLockActive(lock) && lock.supervisorPid !== process.pid) {
      ctx.ui.notify(
        `Note: another pi-tmux-process-manager instance for this Pi session (pid: ${lock.supervisorPid}) may still be running. Taking over.`,
        "warning",
      );
    }
    if (lock && !isLockActive(lock)) clearLock(cwd, sessionKey);

    const sessionName = sessionKey === "cwd" ? `pi-proc-${hash}` : `pi-proc-${hash}-${sessionKey}`;
    const savedState = readState(cwd, sessionKey);
    if (
      savedState &&
      savedState.sessionName === sessionName &&
      savedState.version === STATE_VERSION &&
      savedState.sessionKey === sessionKey
    ) {
      state = reconcileState(savedState);
    } else {
      state = initState(cwd, sessionName, sessionKey);
    }

    if (!sessionExists(sessionName)) createSession(sessionName, cwd);
    if (state) {
      writeState(state);
      writeLock(cwd, {
        cwdHash: hash,
        sessionKey,
        supervisorPid: process.pid,
        startedAt: Date.now(),
      });
      resumeProcessWatches(pi, getState, setState);
      ctx.ui.notify(`Process manager ready (session: ${sessionName})`, "info");
    }
  });

  pi.on("session_shutdown", async () => {
    if (!state) return;
    const reconciled = reconcileState(state);
    writeState(reconciled);
    if (Object.keys(reconciled.entries).length === 0) killSession(reconciled.sessionName);
    clearLock(reconciled.projectPath, reconciled.sessionKey);
    state = null;
  });
}

function getPiSessionIdFromContext(ctx: unknown): string | null {
  if (!ctx || typeof ctx !== "object") return null;
  const record = ctx as Record<string, unknown>;
  const sessionManager = record.sessionManager as
    | { getSessionId?: () => string | null | undefined }
    | undefined;
  try {
    return sessionManager?.getSessionId?.() ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("extension ctx is stale")) return null;
    throw error;
  }
}
