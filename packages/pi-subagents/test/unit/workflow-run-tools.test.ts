import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { registerWorkflowRunTools } from "../../src/extension/workflow-tools.ts";

function makeHarness() {
	const tools = new Map<string, any>();
	const calls: any[] = [];
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	};
	registerWorkflowRunTools({
		pi: pi as any,
		execute: (_id, params) => {
			calls.push(params);
			return { content: [{ type: "text", text: "ok" }], details: { mode: "workflow", results: [] } } as any;
		},
	});
	return { tools, calls, ctx: { cwd: "/repo" } as any, signal: new AbortController().signal };
}

describe("workflow run action tools", () => {
	it("workflow_start defaults missing input to empty args and starts in background", async () => {
		const h = makeHarness();
		await h.tools.get("workflow_start").execute("wf-1", { name: "implementation" }, h.signal, undefined, h.ctx);

		assert.deepEqual(h.calls[0], { action: "run", workflowName: "implementation", args: {}, placement: "background" });
	});

	it("workflow_start accepts explicit background and foreground attachment", async () => {
		const h = makeHarness();
		await h.tools.get("workflow_start").execute("wf-bg", { name: "implementation", placement: "background" }, h.signal, undefined, h.ctx);
		await h.tools.get("workflow_start").execute("wf-fg", { name: "review", placement: "foreground" }, h.signal, undefined, h.ctx);

		assert.deepEqual(h.calls[0], { action: "run", workflowName: "implementation", args: {}, placement: "background" });
		assert.deepEqual(h.calls[1], { action: "run", workflowName: "review", args: {}, placement: "foreground" });
	});

	it("workflow_status routes to existing workflow status action", async () => {
		const h = makeHarness();
		await h.tools.get("workflow_status").execute("wf-status", { id: "wf-abc" }, h.signal, undefined, h.ctx);

		assert.deepEqual(h.calls[0], { action: "status", runId: "wf-abc" });
	});

	it("workflow_list routes to current workflow store", async () => {
		const h = makeHarness();
		await h.tools.get("workflow_list").execute("wf-list", {}, h.signal, undefined, h.ctx);

		assert.deepEqual(h.calls[0], { action: "list" });
	});

	it("workflow_show returns saved workflow metadata and script preview", async () => {
		const h = makeHarness();
		const name = `unit-show-${Date.now()}`;
		const dir = path.join(os.homedir(), ".pi", "agent", "workflows", "saved", name);
		fs.mkdirSync(dir, { recursive: true });
		try {
			fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ name, description: "demo" }, null, 2));
			fs.writeFileSync(path.join(dir, "workflow.js"), "export default async function workflow() { return 'ok'; }\n");

			const result = await h.tools.get("workflow_show").execute("wf-show", { name }, h.signal, undefined, h.ctx);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0].text, new RegExp(`Workflow: ${name}`));
			assert.match(result.content[0].text, /Metadata:/);
			assert.match(result.content[0].text, /Script preview:/);
			assert.match(result.content[0].text, /return 'ok'/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("workflow_show can display bundled workflows", async () => {
		const h = makeHarness();
		const result = await h.tools.get("workflow_show").execute("wf-show-bundled", { name: "implementation" }, h.signal, undefined, h.ctx);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /Workflow: implementation/);
		assert.match(result.content[0].text, /Plan, implement, and review/);
	});

	it("workflow_show reports not found for missing saved workflow", async () => {
		const h = makeHarness();
		const result = await h.tools.get("workflow_show").execute("wf-missing", { name: `missing-${Date.now()}` }, h.signal, undefined, h.ctx);

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Workflow not found/);
	});

	it("workflow_send routes to workflow inbox and workflow_stop preserves reason", async () => {
		const h = makeHarness();
		await h.tools.get("workflow_send").execute("wf-send", { id: "wf-abc", input: "Use option B.", purpose: "answer" }, h.signal, undefined, h.ctx);
		const soft = await h.tools.get("workflow_stop").execute("wf-stop-soft", { id: "wf-abc", reason: "bad branch" }, h.signal, undefined, h.ctx);

		assert.deepEqual(h.calls[0], { action: "send", runId: "wf-abc", message: "Use option B.", purpose: "answer" });
		assert.deepEqual(h.calls[1], { action: "stop", runId: "wf-abc", message: "bad branch" });
		assert.match(soft.content.at(-1).text, /Stop reason: bad branch/);
	});
});
