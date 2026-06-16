/**
 * tmux CLI 封装层
 * 所有 tmux 操作集中在这里，不散落在各处
 *
 * Bug fixes (code-review round 2):
 *   [P1] isPaneDead TOCTOU: re-check windowExists after list-panes fails
 *   [P1] listWindows colon: use \x00 separator instead of : to handle colons in names
 *   [P1] pipePane shell injection: escape logPath with single quotes
 */
import { execFileSync, spawnSync } from "node:child_process";

export interface TmuxWindow {
  index: string;
  name: string;
  paneId: string;
  panePid: string;
  paneDead: boolean;
  paneCurrentCommand: string;
}

export interface TmuxSession {
  name: string;
  windows: TmuxWindow[];
}

// Separator: ASCII Unit Separator (\x1f) — preserved by tmux format output
// Note: NUL (\x00) is stripped by tmux and cannot be used as separator
const SEP = "\x1f";

/** 执行 tmux 命令，返回 stdout */
function run(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** 执行 tmux 命令，失败时抛出含 stderr 的错误（用于需要区分空结果与真实错误的场景）*/
function runStrict(args: string[]): string {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").trim();
    throw new Error(`tmux ${args[0]} failed (exit ${r.status}): ${stderr || "(no stderr)"}`);
  }
  return (r.stdout ?? "").trim();
}

/** 执行 tmux 命令，返回是否成功 */
function runOk(args: string[]): boolean {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  return r.status === 0;
}

// ─── Session ────────────────────────────────────────────────────────────────

export function sessionExists(sessionName: string): boolean {
  return runOk(["has-session", "-t", sessionName]);
}

export function createSession(sessionName: string, cwd: string): boolean {
  return runOk(["new-session", "-d", "-s", sessionName, "-x", "220", "-y", "50", "-c", cwd]);
}

export function killSession(sessionName: string): boolean {
  return runOk(["kill-session", "-t", sessionName]);
}

/** 返回所有 tmux session 名 */
export function listSessions(): string[] {
  const r = run(["list-sessions", "-F", "#{session_name}"]);
  return r ? r.split("\n").map(s => s.trim()).filter(Boolean) : [];
}

// ─── Window ─────────────────────────────────────────────────────────────────

export function listWindows(sessionName: string): TmuxWindow[] {
  return listWindowsSafe(sessionName) ?? [];
}

/**
 * Like listWindows(), but returns null for genuine tmux errors so callers such as
 * reconcileState do not confuse a transient tmux failure with "no windows" and
 * delete all state.
 */
export function listWindowsSafe(sessionName: string): TmuxWindow[] | null {
  const fmt = [
    "#{window_index}", "#{window_name}", "#{pane_id}",
    "#{pane_pid}", "#{pane_dead}", "#{pane_current_command}",
  ].join(SEP);
  let out: string;
  try {
    out = runStrict(["list-windows", "-t", sessionName, "-F", fmt]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("can't find session") || msg.includes("no server running")) return [];
    return null;
  }
  if (!out) return [];
  return out.split("\n").filter(Boolean).map(line => {
    const parts = line.split(SEP);
    const [index, name, paneId, panePid, paneDead, paneCurrentCommand] = parts;
    return { index, name, paneId, panePid, paneDead: paneDead === "1", paneCurrentCommand };
  });
}

export function windowExists(sessionName: string, windowName: string): boolean {
  const windows = listWindows(sessionName);
  return windows.some(w => w.name === windowName);
}

/** 创建新 window，命令在其中运行 */
export function newWindow(sessionName: string, windowName: string, command: string, cwd: string): boolean {
  return runOk(["new-window", "-t", sessionName, "-n", windowName, "-c", cwd, command]);
}

export function killWindow(sessionName: string, windowName: string): boolean {
  return runOk(["kill-window", "-t", `${sessionName}:${windowName}`]);
}

/** 检查 window 的 pane 是否已退出
 *
 * [P1-fix] TOCTOU 修复：
 *   - Case 1: window 消失 (remain-on-exit=off, 进程退出后 window 关闭)
 *   - Case 2: pane_dead=1 (remain-on-exit=on)
 *   - Case 3: list-panes 失败（window 在 Case1 检查后消失）→ 也视为 dead
 */
export function isPaneDead(sessionName: string, windowName: string): boolean {
  // Case 1: window gone
  if (!windowExists(sessionName, windowName)) return true;
  // Case 2/3: query pane_dead; empty result means pane is gone (TOCTOU case) → dead
  const out = run(["list-panes", "-t", `${sessionName}:${windowName}`, "-F", "#{pane_dead}"]);
  if (!out) return true;          // [P1-fix] empty = window disappeared between checks
  return out.trim() === "1";
}

/** 获取 pane 的 PID */
export function getPanePid(sessionName: string, windowName: string): number | null {
  const out = run(["list-panes", "-t", `${sessionName}:${windowName}`, "-F", "#{pane_pid}"]);
  const pid = parseInt(out.trim());
  return isNaN(pid) ? null : pid;
}

/** 获取已退出 pane 的退出码；window/pane 不存在或 tmux 无状态时返回 null。 */
export function getPaneDeadStatus(sessionName: string, windowName: string): number | null {
  const out = run(["list-panes", "-t", `${sessionName}:${windowName}`, "-F", "#{pane_dead_status}"]);
  const status = parseInt(out.trim());
  return isNaN(status) ? null : status;
}

// ─── Output ──────────────────────────────────────────────────────────────────

/** 捕获 window 的最近 N 行输出 */
export function capturePane(sessionName: string, windowName: string, lines = 50): string {
  try {
    const out = runStrict([
      "capture-pane", "-p", "-t", `${sessionName}:${windowName}`,
      "-S", `-${lines}`,
    ]);
    // 简单 ANSI strip
    return out.replace(/\x1B\[[0-9;]*[mGKHF]/g, "").trim();
  } catch {
    return "";
  }
}

/** 向 window 发送文本（send-keys） */
export function sendKeys(sessionName: string, windowName: string, text: string): boolean {
  return runOk(["send-keys", "-t", `${sessionName}:${windowName}`, text, "Enter"]);
}

/** 向 window 粘贴多行内容（load-buffer + paste-buffer） */
export function pasteToWindow(sessionName: string, windowName: string, text: string): boolean {
  const load = spawnSync("tmux", ["load-buffer", "-"], {
    input: text,
    encoding: "utf8",
  });
  if (load.status !== 0) return false;
  if (!runOk(["paste-buffer", "-d", "-t", `${sessionName}:${windowName}`])) return false;
  // send-keys with empty string + Enter sends an extra newline; omit if not needed
  return true;
}

// ─── Monitor ─────────────────────────────────────────────────────────────────

/** 设置静默检测（monitor-silence），seconds=0 关闭 */
export function setMonitorSilence(sessionName: string, windowName: string, seconds: number): void {
  runOk(["set-option", "-t", `${sessionName}:${windowName}`, "monitor-silence", String(seconds)]);
}

/** 持续日志（pipe-pane）
 * [P1-fix] logPath 用单引号转义，防止 shell injection
 */
export function pipePane(sessionName: string, windowName: string, logPath: string): boolean {
  // Escape single quotes in path (replace ' with '\'' )
  const safePath = logPath.replace(/'/g, "'\\''");
  return runOk([
    "pipe-pane", "-t", `${sessionName}:${windowName}`, "-o",
    `cat >> '${safePath}'`,
  ]);
}

// ─── Environment ─────────────────────────────────────────────────────────────

/** 设置 session 级别环境变量（新 window 的 shell 不自动继承，仅作记录） */
export function setEnvironment(sessionName: string, key: string, value: string): void {
  runOk(["set-environment", "-t", sessionName, key, value]);
}

// ─── Version ─────────────────────────────────────────────────────────────────

export function getTmuxVersion(): number | null {
  try {
    const out = execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim();
    const m = out.match(/tmux\s+([\d.]+)/);
    if (!m) return null;
    return parseFloat(m[1]);
  } catch {
    return null;
  }
}
