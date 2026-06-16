/** Pure helpers shared by process-management tools. */
import type { OrchestratorState, ProcessEntry } from "./state.js";

export interface ListResultProcessItem {
  name: string;
  command: string;
  alive: boolean;
  cwd: string;
  startedAt: string;
  exitCode?: number | null;
}

export interface ListResult {
  processes?: ListResultProcessItem[];
}

export function formatList(result: ListResult): string {
  const lines: string[] = [];
  if (result.processes !== undefined) {
    lines.push(`## Processes (${result.processes.length})`);
    if (result.processes.length === 0) lines.push("  (none)");
    for (const processItem of result.processes) {
      const status = processItem.alive ? "🟢 running" : "⚫ stopped";
      lines.push(`  ${status}  ${processItem.name}: ${processItem.command}`);
      lines.push(`    cwd: ${processItem.cwd}`);
      lines.push(`    started: ${processItem.startedAt}`);
      if (!processItem.alive && processItem.exitCode !== undefined && processItem.exitCode !== null) {
        lines.push(`    exit: ${processItem.exitCode}`);
      }
    }
  }
  return lines.join("\n");
}

export function resolveEntry(state: OrchestratorState, target: string): ProcessEntry | null {
  return state.entries[target] ?? null;
}
