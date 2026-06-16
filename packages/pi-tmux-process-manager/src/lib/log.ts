/** Small helpers for reading process logs. */
import * as fs from "node:fs";

const ANSI_RE = /\x1b\[[0-9;?<>]*[a-zA-Z]/g;

export async function waitForLog(logPath: string, timeoutMs = 5_000, pollMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.statSync(logPath).size > 0) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function readLog(logPath: string): string {
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    if (!raw.trim()) return "";
    return raw
      .replace(ANSI_RE, "")
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith("[process_exit:");
      })
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}
