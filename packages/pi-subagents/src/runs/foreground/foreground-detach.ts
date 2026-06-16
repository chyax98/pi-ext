export interface ForegroundDetachHandle {
	runId: string;
	agent: string;
	index?: number;
	startedAt: number;
	requestDetach: (reason: string) => { accepted: boolean; message: string; asyncId?: string; asyncDir?: string };
}

const active = new Map<string, ForegroundDetachHandle>();
let latestKey: string | undefined;

function keyOf(input: { runId: string; index?: number }): string {
	return input.index === undefined ? input.runId : `${input.runId}:${input.index}`;
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
	const handle = latestKey ? active.get(latestKey) : [...active.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
	if (!handle) return { accepted: false, message: "No active foreground child agent run to detach." };
	return handle.requestDetach(reason);
}

export function activeForegroundDetachCount(): number {
	return active.size;
}
