export interface ForegroundDetachRunHandle {
	runId: string;
	mode: "single" | "parallel" | "chain";
	startedAt: number;
	requestDetach: (reason: string) => { accepted: boolean; message: string; asyncId?: string; asyncDir?: string };
}

export interface ForegroundDetachHandle {
	runId: string;
	agent: string;
	index?: number;
	startedAt: number;
	requestDetach: (reason: string) => { accepted: boolean; message: string; asyncId?: string; asyncDir?: string };
}

const activeRuns = new Map<string, ForegroundDetachRunHandle>();
const active = new Map<string, ForegroundDetachHandle>();
let latestRunKey: string | undefined;
let latestKey: string | undefined;

function keyOf(input: { runId: string; index?: number }): string {
	return input.index === undefined ? input.runId : `${input.runId}:${input.index}`;
}

export function registerForegroundDetachRunHandle(handle: ForegroundDetachRunHandle): () => void {
	activeRuns.set(handle.runId, handle);
	latestRunKey = handle.runId;
	return () => {
		activeRuns.delete(handle.runId);
		if (latestRunKey === handle.runId) {
			latestRunKey = [...activeRuns.entries()].sort((a, b) => b[1].startedAt - a[1].startedAt)[0]?.[0];
		}
	};
}

export function registerForegroundDetachHandle(handle: ForegroundDetachHandle): () => void {
	const key = keyOf(handle);
	active.set(key, handle);
	latestKey = key;
	return () => {
		active.delete(key);
		if (latestKey === key) {
			latestKey = [...active.entries()].sort((a, b) => b[1].startedAt - a[1].startedAt)[0]?.[0];
		}
	};
}

export function requestLatestForegroundDetach(reason = "keyboard shortcut"): { accepted: boolean; message: string; asyncId?: string; asyncDir?: string } {
	const runHandle = latestRunKey ? activeRuns.get(latestRunKey) : [...activeRuns.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
	if (runHandle) return runHandle.requestDetach(reason);
	const handle = latestKey ? active.get(latestKey) : [...active.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
	if (!handle) return { accepted: false, message: "No active foreground child agent run to detach." };
	return handle.requestDetach(reason);
}

export function activeForegroundDetachCount(): number {
	return active.size + activeRuns.size;
}
