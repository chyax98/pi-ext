import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  writeState,
  readState,
  reconcileState,
  cwdHash,
  initState,
  STATE_VERSION,
  statePath,
  sessionHash,
} from "../../src/lib/state.ts";
import type { OrchestratorState, ProcessEntry } from "../../src/lib/state.ts";

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-state-test-"));
}

function makeProcess(overrides: Partial<ProcessEntry> = {}): ProcessEntry {
  return {
    type: "process",
    name: "dev-server",
    command: "npm run dev",
    cwd: "/tmp/test",
    startedAt: Date.now(),
    silenceTimeoutSec: 30,
    ...overrides,
  };
}

describe("STATE_VERSION gate", () => {
  it("STATE_VERSION is a positive integer", () => {
    assert.ok(typeof STATE_VERSION === "number" && STATE_VERSION > 0);
  });

  it("initState writes current STATE_VERSION", () => {
    const cwd = tmpCwd();
    const state = initState(cwd, "test-session");
    assert.equal(state.version, STATE_VERSION);
    const read = readState(cwd);
    assert.equal(read!.version, STATE_VERSION);
  });
});

describe("cwdHash", () => {
  it("same path -> same hash", () => {
    assert.equal(cwdHash("/tmp/test"), cwdHash("/tmp/test"));
  });

  it("different paths -> different hash", () => {
    assert.notEqual(cwdHash("/tmp/a"), cwdHash("/tmp/b"));
  });

  it("returns 8-char hex string", () => {
    assert.match(cwdHash("/tmp/test"), /^[0-9a-f]{8}$/);
  });
});

describe("sessionHash", () => {
  it("same Pi session id -> same session key", () => {
    assert.equal(sessionHash("pi-session-1"), sessionHash("pi-session-1"));
  });

  it("different Pi session ids -> different session keys", () => {
    assert.notEqual(sessionHash("pi-session-1"), sessionHash("pi-session-2"));
  });

  it("returns cwd fallback when Pi session id is unavailable", () => {
    assert.equal(sessionHash(null), "cwd");
    assert.equal(sessionHash(undefined), "cwd");
  });

  it("returns 8-char hex string for real Pi session ids", () => {
    assert.match(sessionHash("pi-session-1"), /^[0-9a-f]{8}$/);
  });
});

describe("writeState / readState", () => {
  it("round-trips process entries", () => {
    const cwd = tmpCwd();
    const state = initState(cwd, "test-session");
    state.entries["dev-server"] = makeProcess();
    writeState(state);
    const read = readState(cwd);
    assert.ok(read);
    assert.equal(read!.sessionName, "test-session");
    assert.ok(read!.entries["dev-server"]);
  });

  it("readState returns null for missing state file", () => {
    const cwd = tmpCwd();
    assert.equal(readState(cwd), null);
  });

  it("isolates state for same cwd across Pi session keys", () => {
    const cwd = tmpCwd();
    const a = initState(cwd, "test-session-a", "session-a");
    const b = initState(cwd, "test-session-b", "session-b");
    a.entries["dev-a"] = makeProcess({ name: "dev-a" });
    b.entries["dev-b"] = makeProcess({ name: "dev-b" });
    writeState(a);
    writeState(b);

    assert.notEqual(statePath(cwd, "session-a"), statePath(cwd, "session-b"));
    assert.ok(readState(cwd, "session-a")!.entries["dev-a"]);
    assert.equal(readState(cwd, "session-a")!.entries["dev-b"], undefined);
    assert.ok(readState(cwd, "session-b")!.entries["dev-b"]);
    assert.equal(readState(cwd, "session-b")!.entries["dev-a"], undefined);
  });
});

describe("reconcileState", () => {
  function makeState(cwd: string): OrchestratorState {
    return {
      version: STATE_VERSION,
      sessionName: "nonexistent-session-xyz",
      supervisorPid: process.pid,
      cwdHash: cwdHash(cwd),
      sessionKey: "cwd",
      projectPath: cwd,
      entries: {},
    };
  }

  it("removes tracked processes when their tmux window is gone", () => {
    const cwd = tmpCwd();
    const state = makeState(cwd);
    state.entries["dev-server"] = makeProcess({ name: "dev-server" });
    const reconciled = reconcileState(state);
    assert.equal(Object.keys(reconciled.entries).length, 0);
  });

  it("keeps empty state empty", () => {
    const cwd = tmpCwd();
    const state = makeState(cwd);
    const reconciled = reconcileState(state);
    assert.deepEqual(reconciled.entries, {});
  });
});
