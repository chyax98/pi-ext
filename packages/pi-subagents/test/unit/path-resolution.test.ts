import { describe, test, before, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "../../src/agents/agents.ts";
import { resolveSkillPath, clearSkillCache } from "../../src/agents/skills.ts";

const tmpDir = path.join(os.tmpdir(), "pi-path-resolution-test");
const cwdDir = path.join(tmpDir, "cwd");

const realHomeDir = os.homedir();
const realUserAgentsDir = path.join(realHomeDir, ".agents");
const userAgentsDirBackup = path.join(tmpDir, ".agents_backup");
const testAgentDir = path.join(tmpDir, "agent");
const previousPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

before(() => {
	fs.mkdirSync(cwdDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = testAgentDir;

	if (fs.existsSync(realUserAgentsDir)) {
		fs.cpSync(realUserAgentsDir, userAgentsDirBackup, { recursive: true });
	}
});

after(() => {
	if (fs.existsSync(userAgentsDirBackup)) {
		fs.rmSync(realUserAgentsDir, { recursive: true, force: true });
		fs.cpSync(userAgentsDirBackup, realUserAgentsDir, { recursive: true });
	} else {
		fs.rmSync(realUserAgentsDir, { recursive: true, force: true });
	}
	if (previousPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousPiCodingAgentDir;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Path resolution for skills and canonical agent dirs", () => {
	test("should resolve skills in .agents/skills", () => {
		const skillsDir = path.join(cwdDir, ".agents", "skills");
		fs.mkdirSync(skillsDir, { recursive: true });
		fs.writeFileSync(path.join(skillsDir, "test-skill-1.md"), "---\nname: test-skill-1\ndescription: test desc\n---\nSkill content");

		clearSkillCache();
		const resolved = resolveSkillPath("test-skill-1", cwdDir);
		assert.ok(resolved);
		assert.strictEqual(resolved?.path, path.join(skillsDir, "test-skill-1.md"));
	});

	test("should resolve skills in ~/.agents/skills", () => {
		const userSkillsDir = path.join(realHomeDir, ".agents", "skills");
		fs.mkdirSync(userSkillsDir, { recursive: true });
		fs.writeFileSync(path.join(userSkillsDir, "test-skill-2.md"), "---\nname: test-skill-2\ndescription: test desc\n---\nSkill content");

		clearSkillCache();
		const resolved = resolveSkillPath("test-skill-2", cwdDir);
		assert.ok(resolved);
		assert.strictEqual(resolved?.path, path.join(userSkillsDir, "test-skill-2.md"));
	});

	test("should resolve project agents only from .pi/agent/agents", () => {
		const legacyDir = path.join(cwdDir, ".agents");
		const agentsDir = path.join(cwdDir, ".pi", "agent", "agents");
		fs.mkdirSync(path.join(cwdDir, ".agents", "skills"), { recursive: true });
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(legacyDir, "test-agent-legacy.md"),
			"---\nkind: agent\nname: test-agent-legacy\ndescription: Legacy agent\n---\nLegacy content"
		);
		fs.writeFileSync(
			path.join(agentsDir, "test-agent-1.md"),
			"---\nname: test-agent-1\ndescription: Test agent\n---\nAgent content"
		);

		const result = discoverAgents(cwdDir, "project");
		assert.equal(result.agents.some((a) => a.name === "test-agent-legacy"), false);
		const agent = result.agents.find((a) => a.name === "test-agent-1");
		assert.ok(agent);
		assert.strictEqual(agent?.filePath, path.join(agentsDir, "test-agent-1.md"));
	});

	test("should resolve user agents from PI_CODING_AGENT_DIR/agents", () => {
		const userAgentsDir = path.join(testAgentDir, "agents");
		fs.mkdirSync(userAgentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(userAgentsDir, "test-agent-2.md"),
			"---\nkind: agent\nname: test-agent-2\ndescription: Test agent\n---\nAgent content"
		);

		const result = discoverAgents(cwdDir, "user");
		const agent = result.agents.find((a) => a.name === "test-agent-2");
		assert.ok(agent);
		assert.strictEqual(agent?.filePath, path.join(userAgentsDir, "test-agent-2.md"));
	});

	test("should let project agents override global agents", () => {
		const userAgentsDir = path.join(testAgentDir, "agents");
		const projectAgentsDir = path.join(cwdDir, ".pi", "agent", "agents");
		fs.mkdirSync(userAgentsDir, { recursive: true });
		fs.mkdirSync(projectAgentsDir, { recursive: true });
		fs.writeFileSync(path.join(userAgentsDir, "shared.md"), "---\nkind: agent\nname: shared\ndescription: Global shared\n---\nGlobal content");
		fs.writeFileSync(path.join(projectAgentsDir, "shared.md"), "---\nkind: agent\nname: shared\ndescription: Project shared\n---\nProject content");

		const result = discoverAgents(cwdDir, "both");
		const shared = result.agents.find((a) => a.name === "shared");
		assert.ok(shared);
		assert.equal(shared.description, "Project shared");
		assert.equal(shared.filePath, path.join(projectAgentsDir, "shared.md"));
	});

	test("should not resolve skills or unmarked markdown in .agents as agents", () => {
		const legacyDir = path.join(cwdDir, ".agents");
		const skillsDir = path.join(legacyDir, "skills", "skillish");
		fs.mkdirSync(skillsDir, { recursive: true });
		fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "---\nname: skillish\ndescription: Skill desc\n---\nSkill body");
		fs.writeFileSync(path.join(legacyDir, "note.md"), "---\nname: note\ndescription: Not agent\n---\nNote body");

		const result = discoverAgents(cwdDir, "project");
		assert.equal(result.agents.some((a) => a.name === "skillish"), false);
		assert.equal(result.agents.some((a) => a.name === "note"), false);
	});
});
