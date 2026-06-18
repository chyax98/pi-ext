import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerAgentRunTools } from "../../src/extension/agent-tools.ts";

function makeHarness() {
	const tools = new Map<string, any>();
	const calls: any[] = [];
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	};
	registerAgentRunTools({
		pi: pi as any,
		discoverAgents: () => ({
			agents: [
				{ name: "scout", localName: "scout", description: "Read-only scout", tools: ["read"], defaultContext: "fresh" },
				{ name: "worker", localName: "worker", description: "Implementation worker", tools: ["read", "edit"], disabled: true },
			],
		} as any),
		execute: (_id, params) => {
			calls.push(params);
			return { content: [{ type: "text", text: "ok" }], details: { mode: "single", results: [] } } as any;
		},
	});
	return {
		tools,
		calls,
		ctx: {
			cwd: "/repo",
			model: { provider: "openai" },
			modelRegistry: {
				getAvailable() {
					return [
						{ provider: "provider", id: "model" },
						{ provider: "openai", id: "gpt-5" },
						{ provider: "azure", id: "gpt-5" },
						{ provider: "openai", id: "gpt-5-mini" },
						{ provider: "anthropic", id: "claude-sonnet-4" },
					];
				},
			},
		} as any,
		signal: new AbortController().signal,
	};
}

describe("agent run action tools", () => {
	it("agent_roles lists runnable roles by default and can include disabled roles", async () => {
		const h = makeHarness();
		const normal = await h.tools.get("agent_roles").execute("t1", {}, h.signal, undefined, h.ctx);
		assert.match(normal.content[0].text, /scout/);
		assert.doesNotMatch(normal.content[0].text, /worker/);

		const all = await h.tools.get("agent_roles").execute("t2", { includeDisabled: true }, h.signal, undefined, h.ctx);
		assert.match(all.content[0].text, /worker \(disabled\)/);
	});

	it("agent_models lists available canonical ids and role context", async () => {
		const h = makeHarness();
		const all = await h.tools.get("agent_models").execute("models-1", {}, h.signal, undefined, h.ctx);
		assert.match(all.content[0].text, /Available models:/);
		assert.match(all.content[0].text, /openai\/gpt-5/);
		assert.match(all.content[0].text, /anthropic\/claude-sonnet-4/);

		const role = await h.tools.get("agent_models").execute("models-2", { role: "scout" }, h.signal, undefined, h.ctx);
		assert.match(role.content[0].text, /Available models for scout:/);

		const missing = await h.tools.get("agent_models").execute("models-3", { role: "missing" }, h.signal, undefined, h.ctx);
		assert.equal(missing.isError, true);
	});

	it("agent_start maps context, skills, extensions, runtime, output, and isolation to real subagent params", async () => {
		const h = makeHarness();
		await h.tools.get("agent_start").execute("run-1", {
			placement: "background",
			isolation: "git-worktree",
			output: { path: "reports/scout.md", mode: "file-only" },
			agents: [{
				role: "scout",
				task: "Inspect auth flow.",
				cwd: "packages/app",
				context: { kind: "fork", reads: ["README.md", "src/auth.ts"], promptContext: "Focus token refresh." },
				authority: { skills: ["diagnose"], extensions: ["/tmp/ext"] },
				runtime: { model: "provider/model", timeoutMs: 1_200_000 },
			}],
		}, h.signal, undefined, h.ctx);

		assert.equal(h.calls.length, 1);
		assert.equal(h.calls[0].async, true);
		assert.equal(h.calls[0].worktree, true);
		assert.equal(h.calls[0].agent, "scout");
		assert.equal(h.calls[0].cwd, "packages/app");
		assert.equal(h.calls[0].context, "fork");
		assert.equal(h.calls[0].model, "provider/model");
		assert.equal(h.calls[0].timeoutMinutes, 20);
		assert.equal(h.calls[0].output, "reports/scout.md");
		assert.equal(h.calls[0].outputMode, "file-only");
		assert.deepEqual(h.calls[0].skill, ["diagnose"]);
		assert.deepEqual(h.calls[0].extensionPolicy, { mode: "isolated", include: ["/tmp/ext"] });
		assert.match(h.calls[0].task, /Inspect auth flow\./);
		assert.match(h.calls[0].task, /Manager-supplied context:/);
		assert.match(h.calls[0].task, /Focus token refresh\./);
		assert.match(h.calls[0].task, /- README\.md/);
		assert.match(h.calls[0].task, /- src\/auth\.ts/);
	});

	it("agent_start promotes identical agents output to the top-level output policy", async () => {
		const h = makeHarness();
		await h.tools.get("agent_start").execute("run-output-shim", {
			agents: [
				{ role: "scout", task: "Inspect auth flow.", output: { disable: true } },
				{ role: "scout", task: "Inspect persistence layer.", output: { disable: true } },
			],
			concurrency: 2,
		}, h.signal, undefined, h.ctx);

		assert.equal(h.calls.length, 1);
		assert.equal(h.calls[0].tasks.length, 2);
		assert.equal(h.calls[0].tasks[0].output, false);
		assert.equal(h.calls[0].tasks[1].output, false);
	});

	it("agent_start rejects mixed per-agent output policies with migration guidance", async () => {
		const h = makeHarness();
		const mixed = await h.tools.get("agent_start").execute("run-output-mixed", {
			agents: [
				{ role: "scout", task: "Inspect auth flow.", output: { path: "auth.md" } },
				{ role: "scout", task: "Inspect persistence layer.", output: { path: "persistence.md" } },
			],
		}, h.signal, undefined, h.ctx);
		assert.equal(mixed.isError, true);
		assert.match(mixed.content[0].text, /different agents\[\]\.output values/);
		assert.match(mixed.content[0].text, /split into separate agent_start calls/);
		assert.equal(h.calls.length, 0);

		const partial = await h.tools.get("agent_start").execute("run-output-partial", {
			agents: [
				{ role: "scout", task: "Inspect auth flow.", output: { disable: true } },
				{ role: "scout", task: "Inspect persistence layer." },
			],
		}, h.signal, undefined, h.ctx);
		assert.equal(partial.isError, true);
		assert.match(partial.content[0].text, /only some agents/);
		assert.equal(h.calls.length, 0);
	});

	it("agent_start resolves providerless and typoed runtime models before delegation", async () => {
		const h = makeHarness();
		await h.tools.get("agent_start").execute("run-model", {
			agents: [{ role: "scout", task: "Inspect.", runtime: { model: "gpt-5" } }],
		}, h.signal, undefined, h.ctx);
		assert.equal(h.calls[0].model, "openai/gpt-5");

		await h.tools.get("agent_start").execute("run-model-fuzzy", {
			agents: [{ role: "scout", task: "Inspect.", runtime: { model: "claude-sonet-4" } }],
		}, h.signal, undefined, h.ctx);
		assert.equal(h.calls[1].model, "anthropic/claude-sonnet-4");
	});

	it("agent_start rejects unresolved explicit runtime models before spawning", async () => {
		const h = makeHarness();
		const result = await h.tools.get("agent_start").execute("run-model-bad", {
			agents: [{ role: "scout", task: "Inspect.", runtime: { model: "totally-unknown-model" } }],
		}, h.signal, undefined, h.ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /model for role 'scout' is not available/);
		assert.match(result.content[0].text, /agent_models/);
		assert.equal(h.calls.length, 0);
	});

	it("agent_start rejects conflicting foreground placement and wait none", async () => {
		const h = makeHarness();
		const result = await h.tools.get("agent_start").execute("run-placement-wait-conflict", {
			placement: "foreground",
			wait: "none",
			agents: [{ role: "scout", task: "Inspect." }],
		}, h.signal, undefined, h.ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /placement='foreground' conflicts with wait='none'/);
		assert.equal(h.calls.length, 0);
	});

	it("agent_start rejects unsupported authority fields instead of silently ignoring constraints", async () => {
		const h = makeHarness();
		const result = await h.tools.get("agent_start").execute("run-2", {
			agents: [{ role: "scout", task: "Inspect.", authority: { tools: ["bash"] } }],
		}, h.signal, undefined, h.ctx);

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /unsupported field\(s\): tools/);
		assert.equal(h.calls.length, 0);
	});

	it("agent_start rejects unsupported runtime fields instead of silently ignoring them", async () => {
		const h = makeHarness();
		const result = await h.tools.get("agent_start").execute("run-runtime", {
			agents: [{ role: "scout", task: "Inspect.", runtime: { model: "provider/model", backend: "sdk" } }],
		}, h.signal, undefined, h.ctx);

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /runtime contains unsupported field\(s\): backend/);
		assert.equal(h.calls.length, 0);
	});

	it("agent_start rejects unsupported context object fields", async () => {
		const h = makeHarness();
		const result = await h.tools.get("agent_start").execute("run-context-extra", {
			agents: [{ role: "scout", task: "Inspect.", context: { kind: "fork", unknown: true } }],
		}, h.signal, undefined, h.ctx);

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /context contains unsupported field\(s\): unknown/);
		assert.equal(h.calls.length, 0);
	});

	it("agent_start rejects unsupported isolation values instead of falling back", async () => {
		const h = makeHarness();
		const result = await h.tools.get("agent_start").execute("run-isolation", {
			isolation: "docker",
			agents: [{ role: "scout", task: "Inspect." }],
		}, h.signal, undefined, h.ctx);

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /isolation supports only/);
		assert.equal(h.calls.length, 0);
	});

	it("agent_start maps shared context kind for multi-agent runs and rejects mixed context kinds", async () => {
		const h = makeHarness();
		await h.tools.get("agent_start").execute("run-context", {
			agents: [
				{ role: "scout", task: "Inspect.", context: "fork" },
				{ role: "scout", task: "Inspect again.", context: { kind: "fork", promptContext: "same branch" } },
			],
		}, h.signal, undefined, h.ctx);

		assert.equal(h.calls[0].context, "fork");
		assert.match(h.calls[0].tasks[1].task, /same branch/);

		const mixed = await h.tools.get("agent_start").execute("run-mixed", {
			agents: [
				{ role: "scout", task: "Inspect.", context: "fork" },
				{ role: "scout", task: "Inspect again.", context: "fresh" },
			],
		}, h.signal, undefined, h.ctx);

		assert.equal(mixed.isError, true);
		assert.match(mixed.content[0].text, /one shared context kind/);
	});

	it("agent_start rejects per-agent extension authority in multi-agent mode", async () => {
		const h = makeHarness();
		const result = await h.tools.get("agent_start").execute("run-3", {
			agents: [
				{ role: "scout", task: "Inspect.", authority: { extensions: ["/tmp/ext-a"] } },
				{ role: "scout", task: "Inspect again." },
			],
		}, h.signal, undefined, h.ctx);

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /per-agent extension authority/);
		assert.equal(h.calls.length, 0);
	});

	it("agent_start wait='none' maps to background and agent_status routes directly", async () => {
		const h = makeHarness();
		await h.tools.get("agent_start").execute("run-wait", { wait: "none", agents: [{ role: "scout", task: "Inspect." }] }, h.signal, undefined, h.ctx);
		await h.tools.get("agent_status").execute("status-1", { id: "abc", index: 1 }, h.signal, undefined, h.ctx);

		assert.equal(h.calls[0].async, true);
		assert.deepEqual(h.calls[1], { action: "status", id: "abc", index: 1 });
	});

	it("agent_send and soft agent_stop route to existing resume and interrupt actions", async () => {
		const h = makeHarness();
		const sendResult = await h.tools.get("agent_send").execute("send-1", { id: "abc", input: "Use option B.", purpose: "answer" }, h.signal, undefined, h.ctx);
		const stopResult = await h.tools.get("agent_stop").execute("stop-1", { id: "abc", reason: "Wrong branch" }, h.signal, undefined, h.ctx);

		assert.deepEqual(h.calls[0], { action: "resume", id: "abc", message: "Purpose: answer\n\nUse option B." });
		assert.deepEqual(h.calls[1], { action: "interrupt", id: "abc" });
		assert.equal(sendResult.isError, undefined);
		assert.match(stopResult.content.at(-1).text, /Stop reason: Wrong branch/);
	});
});
