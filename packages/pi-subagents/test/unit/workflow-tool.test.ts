import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkflowExecutor } from "../../src/workflow/workflow-tool.ts";


test("workflow list ignores non-directory entries in runs root", async () => {
	const executor = createWorkflowExecutor(async () => {
		throw new Error("agent should not run while listing workflows");
	});
	const runsDir = path.join(os.homedir(), ".pi", "agent", "workflows", "runs");
	const filePath = path.join(runsDir, `not-a-run-${Date.now()}.txt`);
	fs.mkdirSync(runsDir, { recursive: true });
	fs.writeFileSync(filePath, "not a directory");
	try {
		const result = await executor.run("wf-list", { action: "list" }, new AbortController().signal, undefined, { cwd: process.cwd() } as any);

		assert.equal((result as any).isError, undefined);
		assert.match(result.content[0].text, /Saved workflows:/);
	} finally {
		fs.rmSync(filePath, { force: true });
	}
});
test("workflow agent.background starts a non-blocking async subagent and returns handle", async () => {
	let capturedParams: any;
	const executor = createWorkflowExecutor(async (_id, params) => {
		capturedParams = params;
		return {
			content: [{ type: "text", text: "Async run started" }],
			details: { mode: "single", results: [], asyncId: "async-test-1", asyncDir: "/tmp/async-test-1" },
		} as any;
	});
	const runId = `wf-unit-bg-agent-${Date.now()}`;
	const script = `export default async function workflow({ agent }) {
  return await agent.background({ agent: "delegate", task: "long task", timeoutMinutes: 10 });
}`;
	const result = await executor.run(runId, { action: "run", script, cwd: process.cwd(), placement: "foreground" }, new AbortController().signal, undefined, { cwd: process.cwd() } as any);
	assert.equal((result as any).isError, undefined);
	assert.equal(capturedParams.async, true);
	assert.equal(capturedParams.agent, "delegate");
	assert.equal(capturedParams.task, "long task");
	const runDir = path.join(os.homedir(), ".pi", "agent", "workflows", "runs", new Date().toISOString().slice(0, 7), runId);
	const final = JSON.parse(fs.readFileSync(path.join(runDir, "final.json"), "utf-8"));
	assert.equal(final.status, "running");
	assert.equal(final.asyncId, "async-test-1");
	assert.equal(final.asyncDir, "/tmp/async-test-1");
});

test("workflow agent.run can request background mode explicitly", async () => {
	let capturedParams: any;
	const executor = createWorkflowExecutor(async (_id, params) => {
		capturedParams = params;
		return {
			content: [{ type: "text", text: "Async run started" }],
			details: { mode: "single", results: [], asyncId: "async-test-2", asyncDir: "/tmp/async-test-2" },
		} as any;
	});
	const runId = `wf-unit-bg-agent-run-${Date.now()}`;
	const script = `export default async function workflow({ agent }) {
  return await agent.run({ agent: "delegate", task: "long task", background: true, timeoutMinutes: 10 });
}`;
	const result = await executor.run(runId, { action: "run", script, cwd: process.cwd(), placement: "foreground" }, new AbortController().signal, undefined, { cwd: process.cwd() } as any);
	assert.equal((result as any).isError, undefined);
	assert.equal(capturedParams.async, true);
	const runDir = path.join(os.homedir(), ".pi", "agent", "workflows", "runs", new Date().toISOString().slice(0, 7), runId);
	const final = JSON.parse(fs.readFileSync(path.join(runDir, "final.json"), "utf-8"));
	assert.equal(final.status, "running");
	assert.equal(final.asyncId, "async-test-2");
});

test("workflow_send queues messages that background workflows can consume through inbox API", async () => {
	const executor = createWorkflowExecutor(async () => {
		throw new Error("agent should not run in inbox-only workflow");
	});
	const runId = `wf-unit-inbox-${Date.now()}`;
	const script = `export default async function workflow({ inbox }) {
  const entries = await inbox.wait(0, { timeoutMs: 5000 });
  return entries[0] ?? null;
}`;
	const controller = new AbortController();
	const running = executor.run(runId, { action: "run", script, cwd: process.cwd(), placement: "foreground" }, controller.signal, undefined, { cwd: process.cwd() } as any);

	const runDir = path.join(os.homedir(), ".pi", "agent", "workflows", "runs", new Date().toISOString().slice(0, 7), runId);
	const statusPath = path.join(runDir, "status.json");
	for (let i = 0; i < 30 && !fs.existsSync(statusPath); i++) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(fs.existsSync(statusPath), "expected attached workflow status before sending inbox message");

	const sent = await executor.run("send-inbox", { action: "send", runId, message: "Use option B", purpose: "answer" }, new AbortController().signal, undefined, { cwd: process.cwd() } as any);
	assert.match(sent.content[0].text, /Workflow message queued/);

	await running;
	const final = JSON.parse(fs.readFileSync(path.join(runDir, "final.json"), "utf-8"));
	assert.equal(final.message, "Use option B");
	assert.equal(final.purpose, "answer");
	assert.equal(final.seq, 1);
});

test("background workflow continues after start returns and consumes workflow_send", async () => {
	const executor = createWorkflowExecutor(async () => {
		throw new Error("agent should not run in inbox-only workflow");
	});
	const runId = `wf-unit-background-inbox-${Date.now()}`;
	const script = `export default async function workflow({ inbox }) {
		const entries = await inbox.wait(0, { timeoutMs: 5000 });
		return entries[0] ?? null;
	}`;
	const started = await executor.run(runId, { action: "run", script, cwd: process.cwd() }, new AbortController().signal, undefined, { cwd: process.cwd() } as any);
	assert.match(started.content[0].text, /Workflow started/);

	const runDir = path.join(os.homedir(), ".pi", "agent", "workflows", "runs", new Date().toISOString().slice(0, 7), runId);
	const statusPath = path.join(runDir, "status.json");
	for (let i = 0; i < 30 && !fs.existsSync(statusPath); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.ok(fs.existsSync(statusPath), "expected background workflow status before sending inbox message");

	const sent = await executor.run("send-background-inbox", { action: "send", runId, message: "Continue in background", purpose: "follow-up" }, new AbortController().signal, undefined, { cwd: process.cwd() } as any);
	assert.match(sent.content[0].text, /Workflow message queued/);
	for (let i = 0; i < 60 && !fs.existsSync(path.join(runDir, "final.json")); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	const final = JSON.parse(fs.readFileSync(path.join(runDir, "final.json"), "utf-8"));
	assert.equal(final.message, "Continue in background");
	assert.equal(final.purpose, "follow-up");
	const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
	assert.equal(status.status, "completed");
});

test("workflow_stop stops a running background workflow and persists stopped status", async () => {
	const executor = createWorkflowExecutor(async () => {
		throw new Error("agent should not run in stop-only workflow");
	});
	const runId = `wf-unit-background-stop-${Date.now()}`;
	const script = `export default async function workflow({ inbox }) {
		await inbox.wait(0, { timeoutMs: 5000 });
		return 'should not finish';
	}`;
	const started = await executor.run(runId, { action: "run", script, cwd: process.cwd() }, new AbortController().signal, undefined, { cwd: process.cwd() } as any);
	assert.match(started.content[0].text, /Workflow started/);
	const runDir = path.join(os.homedir(), ".pi", "agent", "workflows", "runs", new Date().toISOString().slice(0, 7), runId);
	const statusPath = path.join(runDir, "status.json");
	for (let i = 0; i < 30 && !fs.existsSync(statusPath); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	const stopped = await executor.run("stop-background-workflow", { action: "stop", runId, message: "test stop" }, new AbortController().signal, undefined, { cwd: process.cwd() } as any);
	assert.match(stopped.content[0].text, /Workflow stop requested/);
	for (let i = 0; i < 60; i++) {
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
		if (status.status === "stopped") break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
	assert.equal(status.status, "stopped");
});

test("workflow_status marks stale orphaned background workflow as paused", async () => {
	const executor = createWorkflowExecutor(async () => {
		throw new Error("agent should not run");
	});
	const runId = `wf-unit-orphan-status-${Date.now()}`;
	const runDir = path.join(os.homedir(), ".pi", "agent", "workflows", "runs", new Date().toISOString().slice(0, 7), runId);
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
		runId,
		status: "running",
		createdAt: new Date(Date.now() - 20_000).toISOString(),
		updatedAt: new Date(Date.now() - 20_000).toISOString(),
		runnerHeartbeatAt: new Date(Date.now() - 20_000).toISOString(),
		cwd: process.cwd(),
		scriptPath: path.join(runDir, "workflow.js"),
		argsPath: path.join(runDir, "args.json"),
		eventsPath: path.join(runDir, "events.jsonl"),
		agentCount: 0,
	}, null, 2));
	const result = await executor.run("wf-status-orphan", { action: "status", runId }, new AbortController().signal, undefined, { cwd: process.cwd() } as any);
	assert.match(result.content[0].text, /orphanedReason/);
	const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
	assert.equal(status.status, "paused");
});

test("workflow_stop closes stale orphaned background workflow instead of leaving only a marker", async () => {
	const executor = createWorkflowExecutor(async () => {
		throw new Error("agent should not run");
	});
	const runId = `wf-unit-orphan-stop-${Date.now()}`;
	const runDir = path.join(os.homedir(), ".pi", "agent", "workflows", "runs", new Date().toISOString().slice(0, 7), runId);
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
		runId,
		status: "running",
		createdAt: new Date(Date.now() - 20_000).toISOString(),
		updatedAt: new Date(Date.now() - 20_000).toISOString(),
		runnerHeartbeatAt: new Date(Date.now() - 20_000).toISOString(),
		cwd: process.cwd(),
		scriptPath: path.join(runDir, "workflow.js"),
		argsPath: path.join(runDir, "args.json"),
		eventsPath: path.join(runDir, "events.jsonl"),
		agentCount: 0,
	}, null, 2));
	const result = await executor.run("wf-stop-orphan", { action: "stop", runId, message: "cleanup" }, new AbortController().signal, undefined, { cwd: process.cwd() } as any);
	assert.match(result.content[0].text, /persisted status was closed/);
	const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
	assert.equal(status.status, "stopped");
	assert.match(status.orphanedReason, /cleanup/);
});

test("workflow async mode starts a background run instead of rejecting", async () => {
	const executor = createWorkflowExecutor(async () => {
		throw new Error("agent should not run");
	});
	const runId = `wf-async-background-${Date.now()}`;
	const result = await executor.run(runId, { action: "run", script: "export default async function workflow() { return 'ok'; }", async: true }, new AbortController().signal, undefined, { cwd: process.cwd() } as any);
	assert.equal((result as any).isError, undefined);
	assert.match(result.content[0].text, /Workflow started/);
	assert.match(result.content[0].text, new RegExp(runId));
	const runDir = path.join(os.homedir(), ".pi", "agent", "workflows", "runs", new Date().toISOString().slice(0, 7), runId);
	for (let i = 0; i < 30 && !fs.existsSync(path.join(runDir, "final.json")); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	const final = JSON.parse(fs.readFileSync(path.join(runDir, "final.json"), "utf-8"));
	assert.equal(final, "ok");
});

test("workflow list includes bundled workflows", async () => {
	const executor = createWorkflowExecutor(async () => {
		throw new Error("agent should not run while listing workflows");
	});
	const result = await executor.run("wf-list-bundled", { action: "list" }, new AbortController().signal, undefined, { cwd: process.cwd() } as any);
	assert.match(result.content[0].text, /implementation/);
	assert.match(result.content[0].text, /review/);
});
