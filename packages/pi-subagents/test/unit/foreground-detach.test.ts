import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activeForegroundDetachCount,
	registerForegroundDetachHandle,
	registerForegroundDetachRunHandle,
	requestLatestForegroundDetach,
} from "../../src/runs/foreground/foreground-detach.ts";

describe("foreground detach registry", () => {
	it("prefers root run detach over child detach handles", () => {
		const before = activeForegroundDetachCount();
		const unregisterChild = registerForegroundDetachHandle({
			runId: "root-priority-test",
			agent: "worker",
			index: 1,
			startedAt: 1,
			requestDetach: () => ({ accepted: true, message: "child", asyncId: "root-priority-test-1" }),
		});
		const unregisterRun = registerForegroundDetachRunHandle({
			runId: "root-priority-test",
			mode: "parallel",
			startedAt: 2,
			requestDetach: () => ({ accepted: true, message: "root", asyncId: "root-priority-test" }),
		});

		try {
			const root = requestLatestForegroundDetach("test");
			assert.equal(root.message, "root");
			assert.equal(root.asyncId, "root-priority-test");

			unregisterRun();
			const child = requestLatestForegroundDetach("test");
			assert.equal(child.message, "child");
			assert.equal(child.asyncId, "root-priority-test-1");
		} finally {
			unregisterRun();
			unregisterChild();
		}

		assert.equal(activeForegroundDetachCount(), before);
	});
});
