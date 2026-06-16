import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_CHILD_COMPLETE_EVENT, SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

function createPi() {
	const events = new EventEmitter();
	const userMessages: Array<{ content: unknown; options: unknown }> = [];
	const customMessages: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events,
		sendMessage(message: unknown, options?: unknown) {
			customMessages.push({ message, options });
		},
		sendUserMessage(content: unknown, options: unknown) {
			userMessages.push({ content, options });
		},
	};

	registerSubagentNotify(pi as never);

	return { events, userMessages, customMessages };
}

describe("registerSubagentNotify", () => {
	it("sends root background completion as one user follow-up input with fallback summary", () => {
		const { events, userMessages, customMessages } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-empty-1",
			agent: "worker",
			success: true,
			summary: "",
			exitCode: 0,
			timestamp: 123,
		});

		assert.equal(customMessages.length, 0);
		assert.deepEqual(userMessages, [{
			content: "Background task completed: **worker**\n\n(no output)",
			options: { deliverAs: "followUp" },
		}]);
	});

	it("preserves non-empty root completion summaries", () => {
		const { events, userMessages } = createPi();
		const summary = "  Done streaming\nAll clear  ";

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-summary-1",
			agent: "worker",
			success: true,
			summary,
			exitCode: 0,
			timestamp: 456,
			taskIndex: 1,
			totalTasks: 3,
		});

		assert.equal(userMessages.length, 1);
		assert.deepEqual(userMessages[0], {
			content: `Background task completed: **worker** (2/3)\n\n${summary}`,
			options: { deliverAs: "followUp" },
		});
	});

	it("preserves session paths in root completion content", () => {
		const { events, userMessages } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-path-1",
			agent: "worker",
			success: true,
			summary: "Done",
			exitCode: 0,
			timestamp: 456,
			sessionFile: "/tmp/session.jsonl",
		});

		assert.deepEqual(userMessages, [{
			content: "Background task completed: **worker**\n\nDone\n\nSession file: /tmp/session.jsonl",
			options: { deliverAs: "followUp" },
		}]);
	});

	it("renders paused root completions passively without waking the main agent", () => {
		const { events, userMessages, customMessages } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-paused-1",
			agent: "worker",
			success: false,
			state: "paused",
			summary: "Paused after interrupt. Waiting for explicit next action.",
			timestamp: 789,
		});

		assert.deepEqual(userMessages, []);
		assert.equal(customMessages.length, 1);
		assert.deepEqual(customMessages[0], {
			message: {
				customType: "subagent-notify",
				content: "Background task paused (terminal): **worker**\n\nPaused after interrupt. Waiting for explicit next action.\nNote: this is a terminal paused result, not an active running job. If it appeared late, the result watcher delivered an already-paused run.\nPaused at: 1970-01-01T00:00:00.789Z\nInspect: agent_status({ id: \"notify-paused-1\" })\nResume: agent_send({ id: \"notify-paused-1\", input: \"...\" })",
				display: true,
			},
			options: undefined,
		});
	});

	it("renders individual child completion passively without waking the main agent", () => {
		const { events, userMessages, customMessages } = createPi();

		events.emit(SUBAGENT_ASYNC_CHILD_COMPLETE_EVENT, {
			id: "run-1",
			sessionId: "session-1",
			agent: "worker",
			status: "failed",
			success: false,
			error: "acceptance rejected",
			outputFile: "/tmp/output-1.log",
			sessionFile: "/tmp/session-1.jsonl",
			taskIndex: 1,
			totalTasks: 3,
		});

		assert.deepEqual(userMessages, []);
		assert.deepEqual(customMessages, [{
			message: {
				customType: "subagent-notify",
				content: "Background child failed: **worker** (2/3)\n\nacceptance rejected\n\nOutput: /tmp/output-1.log\nSession file: /tmp/session-1.jsonl",
				display: true,
			},
			options: undefined,
		}]);
	});

	it("labels paused child notifications as terminal and passive", () => {
		const { events, userMessages, customMessages } = createPi();

		events.emit(SUBAGENT_ASYNC_CHILD_COMPLETE_EVENT, {
			id: "run-paused",
			agent: "scout",
			status: "paused",
			success: false,
			summary: "Paused after interrupt. Waiting for explicit next action.",
			timestamp: 1000,
			taskIndex: 0,
			totalTasks: 2,
		});

		assert.deepEqual(userMessages, []);
		assert.equal(customMessages.length, 1);
		const content = (customMessages[0]?.message as { content?: string }).content ?? "";
		assert.match(content, /Background child paused \(terminal\): \*\*scout\*\* \(1\/2\)/);
		assert.match(content, /not an active running child/);
		assert.match(content, /Paused at: 1970-01-01T00:00:01\.000Z/);
		assert.match(content, /Inspect: agent_status\(\{ id: "run-paused", index: 0 \}\)/);
		assert.match(content, /Resume: agent_send\(\{ id: "run-paused", index: 0, input: "\.\.\." \}\)/);
	});
});
