import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { appendManagedAgentSystemPrompt, MANAGED_AGENT_PROMPT_TEMPLATE_DIR } from "../../src/extension/managed-agent-prompt.ts";

describe("managed-agent native prompt support", () => {
	it("appends managed-agent guidance idempotently", () => {
		const once = appendManagedAgentSystemPrompt("base prompt");
		const twice = appendManagedAgentSystemPrompt(once);
		assert.match(once, /Managed child agents/);
		assert.match(once, /agent_start/);
		assert.match(once, /workflow_send/);
		assert.match(once, /Default\/omitted placement is foreground blocking wait/);
		assert.match(once, /put timeout\/model overrides inside each `agents\[\]\.runtime`/);
		assert.match(once, /Do not mix `context: "fresh"` and `context: "fork"` in one call/);
		assert.match(once, /multiple `scout` agents in the same `cwd`/);
		assert.match(once, /do not loop, sleep, or repeatedly call `agent_status` just to wait/);
		assert.equal(twice, once);
	});

	it("ships bundled prompt templates in the native Pi prompt-template shape", () => {
		const names = fs.readdirSync(MANAGED_AGENT_PROMPT_TEMPLATE_DIR)
			.filter((entry) => entry.endsWith(".md"))
			.map((entry) => path.basename(entry, ".md"))
			.sort();
		assert.deepEqual(names, ["fix-bug", "implement", "plan", "review"]);
		for (const name of names) {
			const content = fs.readFileSync(path.join(MANAGED_AGENT_PROMPT_TEMPLATE_DIR, `${name}.md`), "utf-8");
			assert.match(content, /^---\ndescription:/);
			assert.match(content, /argument-hint:/);
			assert.match(content, /agent_start|managed-agent|reviewer|planner|worker/i);
		}
	});
});
