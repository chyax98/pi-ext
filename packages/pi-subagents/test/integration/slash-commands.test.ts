import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

type RegisteredSlashCommand = {
	description?: string;
	handler(args: string, ctx: unknown): Promise<void>;
	getArgumentCompletions?: (prefix: string) => unknown;
};

interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

interface RegisterSlashCommandsModule {
	registerSlashCommands?: (
		pi: {
			events: EventBus;
			registerCommand(name: string, spec: RegisteredSlashCommand): void;
			registerShortcut(key: string, spec: { handler(ctx: unknown): Promise<void> }): void;
			sendMessage(message: unknown): void;
		},
		state: {
			baseCwd: string;
			currentSessionId: string | null;
			asyncJobs: Map<string, unknown>;
			cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
			lastUiContext: unknown;
			poller: NodeJS.Timeout | null;
			completionSeen: Map<string, number>;
			watcher: unknown;
			watcherRestartTimer: ReturnType<typeof setTimeout> | null;
			resultFileCoalescer: { schedule(file: string, delayMs?: number): boolean; clear(): void };
		},
	) => void;
}

interface SlashLiveStateModule {
	clearSlashSnapshots?: typeof import("../../src/slash/slash-live-state.ts").clearSlashSnapshots;
}

let registerSlashCommands: RegisterSlashCommandsModule["registerSlashCommands"];
let clearSlashSnapshots: SlashLiveStateModule["clearSlashSnapshots"];
let available = true;
try {
	({ registerSlashCommands } = await import("../../src/slash/slash-commands.ts") as RegisterSlashCommandsModule);
	({ clearSlashSnapshots } = await import("../../src/slash/slash-live-state.ts") as SlashLiveStateModule);
} catch {
	available = false;
}

function createEventBus(): EventBus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(event, handler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
		},
		emit(event, data) {
			for (const handler of handlers.get(event) ?? []) handler(data);
		},
	};
}

function createState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function createCommandContext(overrides: Partial<{ cwd: string; notify: (message: string, type?: string) => void }> = {}) {
	return {
		cwd: overrides.cwd ?? process.cwd(),
		hasUI: false,
		ui: {
			notify: overrides.notify ?? ((_message: string) => {}),
			setStatus: (_key: string, _text: string | undefined) => {},
			setToolsExpanded: (_expanded: boolean) => {},
			onTerminalInput: () => () => {},
			custom: async () => undefined,
		},
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => null,
			getSessionId: () => "session-test",
		},
	};
}

async function withTempProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-managed-agent-slash-"));
	fs.mkdirSync(path.join(root, ".pi", "agent", "agents"), { recursive: true });
	try {
		fs.writeFileSync(path.join(root, ".pi", "agent", "agents", "helper.md"), "---\nname: helper\ndescription: Helper\n---\nHelp.\n", "utf-8");
		return await fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function registerForTest(cwd: string) {
	const commands = new Map<string, RegisteredSlashCommand>();
	const sentMessages: unknown[] = [];
	const events = createEventBus();
	let requestedParams: unknown;
	events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
		const payload = data as { requestId: string; params?: unknown };
		requestedParams = payload.params;
		events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
		events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
			requestId: payload.requestId,
			result: {
				content: [{ type: "text", text: "managed-agent slash finished" }],
				details: { mode: "single", results: [] },
			},
			isError: false,
		});
	});
	registerSlashCommands!({
		events,
		registerCommand(name, spec) { commands.set(name, spec); },
		registerShortcut() {},
		sendMessage(message) { sentMessages.push(message); },
	}, createState(cwd));
	return { commands, sentMessages, getRequestedParams: () => requestedParams };
}

async function captureSlashParams(commandName: string, args: string, cwd: string): Promise<{ params: unknown; notifications: string[]; messages: unknown[] }> {
	const { commands, sentMessages, getRequestedParams } = registerForTest(cwd);
	const notifications: string[] = [];
	const command = commands.get(commandName);
	assert.ok(command, `expected /${commandName} to be registered`);
	await command.handler(args, createCommandContext({
		cwd,
		notify: (message) => notifications.push(message),
	}));
	return { params: getRequestedParams(), notifications, messages: sentMessages };
}

describe("managed-agent slash commands", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => clearSlashSnapshots?.());

	it("registers only current public slash commands", async () => {
		await withTempProject(async (root) => {
			const { commands } = registerForTest(root);
			assert.deepEqual([...commands.keys()].sort(), [
				"agent-send",
				"agent-start",
				"agent-status",
				"agent-stop",
				"agents-doctor",
			]);
			for (const removed of ["run", "parallel", "chain", "run-chain", "subagents-doctor"]) {
				assert.equal(commands.has(removed), false, `removed legacy command /${removed} must not be registered`);
			}
		});
	});

	it("/agent-start maps role/task/bg/fork to managed-agent execution params", async () => {
		await withTempProject(async (root) => {
			const { params, messages } = await captureSlashParams("agent-start", "helper -- Do work --bg --fork", root);
			assert.deepEqual(params, {
				agent: "helper",
				task: "Do work",
				clarify: false,
				agentScope: "both",
				async: true,
				context: "fork",
			});
			assert.equal(messages.length, 2);
		});
	});

	it("/agent-start rejects unknown roles without launching", async () => {
		await withTempProject(async (root) => {
			const { params, notifications } = await captureSlashParams("agent-start", "missing -- Do work", root);
			assert.equal(params, undefined);
			assert.deepEqual(notifications, ["Unknown managed-agent role: missing"]);
		});
	});

	it("maps status/send/stop/doctor slash commands to existing runtime actions", async () => {
		await withTempProject(async (root) => {
			assert.deepEqual((await captureSlashParams("agent-status", "run-123", root)).params, { action: "status", id: "run-123" });
			assert.deepEqual((await captureSlashParams("agent-send", "run-123 -- continue", root)).params, { action: "resume", id: "run-123", message: "continue" });
			assert.deepEqual((await captureSlashParams("agent-stop", "run-123 -- stop now", root)).params, { action: "interrupt", id: "run-123", message: "stop now" });
			assert.deepEqual((await captureSlashParams("agents-doctor", "", root)).params, { action: "doctor" });
		});
	});

	it("validates send/stop delimiter before launching", async () => {
		await withTempProject(async (root) => {
			const send = await captureSlashParams("agent-send", "run-123 continue", root);
			assert.equal(send.params, undefined);
			assert.deepEqual(send.notifications, ["Usage: /agent-send <run-id> -- <message>"]);
			const stop = await captureSlashParams("agent-stop", "run-123", root);
			assert.equal(stop.params, undefined);
			assert.deepEqual(stop.notifications, ["Usage: /agent-stop <run-id> -- <reason>"]);
		});
	});

	it("/agent-start completions use current project roles", async () => {
		await withTempProject(async (root) => {
			const { commands } = registerForTest(root);
			const completions = commands.get("agent-start")?.getArgumentCompletions?.("he");
			assert.deepEqual(completions, [{ value: "helper", label: "helper" }]);
		});
	});
});
