import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

function readRegisteredAgentStartDescription(): string {
	const testDir = path.dirname(fileURLToPath(import.meta.url));
	const source = fs.readFileSync(path.resolve(testDir, "..", "..", "src/extension/agent-tools.ts"), "utf-8");
	const match = source.match(/name:\s*"agent_start",[\s\S]*?description:\s*"([\s\S]*?)",\n\s*parameters: AgentStartParams,/);
	assert.ok(match, "expected to find the registered agent_start tool description");
	return match[1]!;
}

describe("registered managed-agent tool description", () => {
	it("does not advertise hardcoded builtin agent names or legacy subagent protocol", () => {
		const description = readRegisteredAgentStartDescription();

		for (const builtinName of ["delegate", "scout", "worker", "planner", "reviewer"]) {
			assert.doesNotMatch(description, new RegExp(`\\b${builtinName}\\b`));
		}
		assert.match(description, /Start one or more managed child Pi agents/i);
		assert.match(description, /Default is foreground\/blocking wait/i);
		assert.match(description, /placement:'background'/i);
		assert.match(description, /do not poll agent_status just to wait/i);
		assert.doesNotMatch(description, /chain/i);
	});
});
