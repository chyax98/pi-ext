import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLog, waitForLog } from "../../src/lib/log.ts";
import type { ProcessEntry } from "../../src/lib/state.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "logs-fallback-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("tmux_logs log fallback — readLog", () => {
  test("readLog returns content when log file exists", () => {
    const logPath = join(tmpDir, "proc-test.log");
    writeFileSync(logPath, "logs-fallback-test-ok\n[process_exit:0]\n");

    const content = readLog(logPath);
    assert.ok(content.includes("logs-fallback-test-ok"));
    assert.ok(!content.includes("process_exit"));
  });

  test("readLog returns empty string when log file is missing", () => {
    const logPath = join(tmpDir, "nonexistent.log");
    const content = readLog(logPath);
    assert.equal(content, "");
  });
});

describe("ProcessEntry log fields", () => {
  test("ProcessEntry accepts logPath and pidPath fields", () => {
    const entry: ProcessEntry = {
      type: "process",
      name: "dev-server",
      command: "npm run dev",
      cwd: "/tmp/test",
      logPath: "/tmp/logs/dev-server.log",
      pidPath: "/tmp/logs/dev-server.pid",
      startedAt: Date.now(),
      silenceTimeoutSec: 30,
    };
    assert.equal(entry.logPath, "/tmp/logs/dev-server.log");
    assert.equal(entry.pidPath, "/tmp/logs/dev-server.pid");
  });
});

describe("logs fallback logic simulation", () => {
  test("when capturePane returns empty and logPath has content → returns log lines", () => {
    const logPath = join(tmpDir, "proc-test.log");
    const expectedOutput = "logs-fallback-test-ok";
    writeFileSync(logPath, expectedOutput + "\n");

    const captureResult = "";
    const lines = 50;
    let output = captureResult;

    if (!output) {
      const logContent = readLog(logPath);
      if (logContent) output = logContent.split("\n").slice(-lines).join("\n");
    }

    assert.ok(output.includes(expectedOutput));
  });
});

describe("waitForLog", () => {
  test("resolves immediately when file already has content", async () => {
    const logPath = join(tmpDir, "ready.log");
    writeFileSync(logPath, "already done\n");

    const start = Date.now();
    await waitForLog(logPath, 2000, 50);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 300, `should resolve quickly, took ${elapsed}ms`);
  });

  test("resolves after file is written (async)", async () => {
    const logPath = join(tmpDir, "delayed.log");
    setTimeout(() => writeFileSync(logPath, "written after delay\n"), 100);

    const start = Date.now();
    await waitForLog(logPath, 2000, 50);
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 80);
    assert.ok(elapsed < 500, `should not wait too long, took ${elapsed}ms`);
  });
});
