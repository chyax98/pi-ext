import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STATE_VERSION } from "../../src/lib/state.ts";
import type { OrchestratorState, ProcessEntry } from "../../src/lib/state.ts";
import { formatList, resolveEntry } from "../../src/lib/tool-helpers.ts";

function makeState(entries: Record<string, ProcessEntry> = {}): OrchestratorState {
  return {
    version: STATE_VERSION,
    sessionName: "test-session",
    supervisorPid: process.pid,
    cwdHash: "abcd1234",
    sessionKey: "cwd",
    projectPath: "/tmp/test",
    entries,
  };
}

function makeProcess(name: string, overrides: Partial<ProcessEntry> = {}): ProcessEntry {
  return {
    type: "process",
    name,
    command: "npm run dev",
    cwd: "/tmp/test",
    startedAt: Date.now(),
    silenceTimeoutSec: 30,
    ...overrides,
  };
}

describe("formatList", () => {
  it("shows (none) for empty processes", () => {
    const result = formatList({ processes: [] });
    assert.ok(result.includes("(none)"));
  });

  it("shows process name and command", () => {
    const result = formatList({
      processes: [{
        name: "dev-server",
        command: "npm run dev",
        alive: true,
        cwd: "/tmp/test",
        startedAt: new Date(0).toISOString(),
      }],
    });
    assert.ok(result.includes("dev-server"));
    assert.ok(result.includes("npm run dev"));
    assert.ok(result.includes("running"));
  });
});

describe("resolveEntry", () => {
  it("resolves process by exact name", () => {
    const state = makeState({ "dev-server": makeProcess("dev-server") });
    const entry = resolveEntry(state, "dev-server");
    assert.ok(entry);
    assert.equal(entry?.type, "process");
  });

  it("returns null for unknown target", () => {
    const state = makeState();
    assert.equal(resolveEntry(state, "missing"), null);
  });
});
