/**
 * OpenViking Session 同步管理
 *
 * 职责：把 pi 会话消息完整同步到 OV，触发 commit。不筛选、不截断、不去重。
 * OV 服务端自己负责提取、去重、合并。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OpenVikingClient } from "./client.js";
import {
	clearOvSessionId,
	getOvSessionIdFromContext,
	getPiSessionIdForOvSessionId,
	getPiSessionIdFromContext,
	setOvSessionId,
} from "./session-registry.js";
import type { OpenVikingConfig, OVTask } from "./types.js";
import { invalidateSessionOverview } from "./recall.js";

type MessageRole = "user" | "assistant";

interface SessionState {
	piSessionId: string;
	ovSessionId: string;
	pendingChars: number;
	commitTaskId?: string;
	commitPendingChars?: number;
	flushPromise?: Promise<void>;
	lastTask?: OVTask | null;
}

export interface CommitExecutionResult {
	session_id: string;
	status: "idle" | "accepted" | "completed" | "failed";
	task_id?: string;
	task?: OVTask | null;
	pending_chars: number;
	tracked: boolean;
}

let sharedClient: OpenVikingClient | null = null;
let sharedConfig: OpenVikingConfig | null = null;
const sessions = new Map<string, SessionState>();

const SESSION_MAP_PATH = resolve(homedir(), ".pi", "agent", "ov-session-map.json");

function loadSessionMap(): Map<string, string> {
	const map = new Map<string, string>();
	try {
		if (!existsSync(SESSION_MAP_PATH)) return map;
		const data = JSON.parse(readFileSync(SESSION_MAP_PATH, "utf-8"));
		if (data && typeof data === "object") {
			for (const [k, v] of Object.entries(data)) {
				if (typeof v === "string") map.set(k, v);
			}
		}
	} catch {
		// ignore
	}
	return map;
}

function saveSessionMap() {
	try {
		const data: Record<string, string> = {};
		for (const [k, v] of sessions.entries()) {
			data[k] = v.ovSessionId;
		}
		writeFileSync(SESSION_MAP_PATH, JSON.stringify(data, null, 2));
	} catch {
		// ignore
	}
}

export function setupSessionSync(pi: ExtensionAPI, config: OpenVikingConfig) {
	sharedClient = new OpenVikingClient(config);
	sharedConfig = config;

	pi.on("session_start", async (_event, ctx) => {
		try {
			const piSessionId = getPiSessionIdFromContext(ctx);
			if (!piSessionId) return;

			const persisted = loadSessionMap().get(piSessionId);
			const intendedId = persisted ?? deriveOvSessionId(piSessionId);

			// Fire-and-forget: 不在 session_start 里噢待 OV HTTP 连接，避免阴塞 reload/新建会话。
			// ensureSession 完成前的 agent_end 消息会静默丢弃（sessions.get 返回 undefined），可接受。
			ensureSession(intendedId)
				.then((ovSessionId) => {
					sessions.set(piSessionId, { piSessionId, ovSessionId, pendingChars: 0 });
					setOvSessionId(piSessionId, ovSessionId);
					saveSessionMap();
				})
				.catch((err) => {
					console.error("[openviking] Session setup failed:", err);
				});
		} catch (err) {
			if (!isStaleCtxError(err)) throw err;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		try {
			const piSessionId = getPiSessionIdFromContext(ctx);
			if (!piSessionId) return;

			const session = sessions.get(piSessionId);
			if (!session) return;

			const batch: Array<{ role: MessageRole; content: string }> = [];
			for (const msg of event.messages) {
				const raw = msg as unknown as Record<string, unknown>;
				const role = typeof raw.role === "string" ? raw.role : "";
				let text = "";

				if (role === "user" || role === "assistant") {
					text = extractText(raw.content);
				} else if (role === "toolResult") {
					text = extractToolResultText(raw.content, typeof raw.toolName === "string" ? raw.toolName : undefined);
				}

				if (!text) continue;
				const clean = stripPollution(text);
				if (!clean) continue;

				const ovRole: MessageRole = role === "user" ? "user" : "assistant";
				batch.push({ role: ovRole, content: clean });
				session.pendingChars += clean.length;
			}
			if (batch.length > 0) {
				await getClient().batchAddMessages(session.ovSessionId, batch);
			}

			if (config.autoCommit.enabled) {
				await commitTrackedSession(session, { force: false, waitForCompletion: false });
			}
		} catch (err) {
			if (!isStaleCtxError(err)) throw err;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			const piSessionId = getPiSessionIdFromContext(ctx);
			if (!piSessionId) return;

			const session = sessions.get(piSessionId);
			if (!session) return;

			// Fire-and-forget: OV 服务端异步处理 commit，不在 shutdown 里卢待完成。
			// waitForCompletion: true 会 poll 最多 30s，导致新建会话 / reload 卡住。
			commitTrackedSession(session, { force: true, waitForCompletion: false }).catch((err) => {
				if (!isStaleCtxError(err)) console.warn("[openviking] Shutdown commit failed:", err);
			});
			clearOvSessionId(piSessionId);
			sessions.delete(piSessionId);
			saveSessionMap();
		} catch (err) {
			if (!isStaleCtxError(err)) throw err;
		}
	});
}

export async function commitSession(options: {
	ctx?: unknown;
	sessionId?: string;
	force?: boolean;
	waitForCompletion?: boolean;
	signal?: AbortSignal;
}): Promise<CommitExecutionResult> {
	const ovSessionId = options.sessionId ?? getOvSessionIdFromContext(options.ctx);
	if (!ovSessionId) {
		throw new Error(
			"No OpenViking session available. Ensure session sync is active or provide session_id.",
		);
	}

	const piSessionId =
		getPiSessionIdFromContext(options.ctx) ?? getPiSessionIdForOvSessionId(ovSessionId);
	const tracked = piSessionId ? sessions.get(piSessionId) : undefined;
	if (tracked && tracked.ovSessionId === ovSessionId) {
		return commitTrackedSession(tracked, {
			force: options.force ?? true,
			waitForCompletion: options.waitForCompletion ?? true,
			signal: options.signal,
		});
	}

	const client = getClient();
	const start = await client.commit(ovSessionId, options.signal);
	const accepted: CommitExecutionResult = {
		session_id: ovSessionId,
		status: start.task_id ? "accepted" : "completed",
		task_id: start.task_id,
		pending_chars: 0,
		tracked: false,
	};
	if (!start.task_id || !options.waitForCompletion) {
		return accepted;
	}

	const task = await waitForTask(client, start.task_id, options.signal);
	return {
		session_id: ovSessionId,
		status: task?.status === "completed" ? "completed" : task?.status === "failed" ? "failed" : "accepted",
		task_id: start.task_id,
		task,
		pending_chars: 0,
		tracked: false,
	};
}

export function getTrackedSessionSnapshot(options: {
	ctx?: unknown;
	sessionId?: string;
}) {
	const ovSessionId = options.sessionId ?? getOvSessionIdFromContext(options.ctx);
	if (!ovSessionId) return null;

	const piSessionId =
		getPiSessionIdFromContext(options.ctx) ?? getPiSessionIdForOvSessionId(ovSessionId);
	if (!piSessionId) return null;

	const session = sessions.get(piSessionId);
	if (!session || session.ovSessionId !== ovSessionId) return null;

	return {
		piSessionId: session.piSessionId,
		ovSessionId: session.ovSessionId,
		commitTaskId: session.commitTaskId ?? null,
		pendingChars: session.pendingChars,
		lastTask: session.lastTask ?? null,
	};
}

function deriveOvSessionId(piSessionId: string): string {
	return `pi-${piSessionId}`;
}

async function ensureSession(ovSessionId: string): Promise<string> {
	const client = getClient();
	try {
		await client.getSession(ovSessionId);
		return ovSessionId;
	} catch {
		try {
			const result = await client.createSession({
				id: ovSessionId,
				metadata: { source: "pi-extension", derived: true },
			});
			return result.session_id;
		} catch {
			const result = await client.createSession({
				metadata: {
					source: "pi-extension",
					intended_id: ovSessionId,
				},
			});
			return result.session_id;
		}
	}
}

async function commitTrackedSession(
	session: SessionState,
	options: { force: boolean; waitForCompletion: boolean; signal?: AbortSignal },
): Promise<CommitExecutionResult> {
	if (session.commitTaskId) {
		if (options.waitForCompletion) {
			await waitForCommitCompletion(session, options.signal);
		} else {
			await pollCommitTask(session, options.signal);
		}
		if (session.commitTaskId) {
			return {
				session_id: session.ovSessionId,
				status: "accepted",
				task_id: session.commitTaskId,
				task: session.lastTask ?? null,
				pending_chars: session.pendingChars,
				tracked: true,
			};
		}
	}

	if (session.pendingChars <= 0) {
		return {
			session_id: session.ovSessionId,
			status: "idle",
			pending_chars: 0,
			tracked: true,
		};
	}

	if (!options.force) {
		const shouldCommit = await shouldAutoCommit(session, options.signal);
		if (!shouldCommit) {
			return {
				session_id: session.ovSessionId,
				status: "idle",
				pending_chars: session.pendingChars,
				tracked: true,
			};
		}
	}

	const client = getClient();
	const snapshotPendingChars = session.pendingChars;
	try {
		let result = await client.commit(session.ovSessionId, options.signal);
		session.commitPendingChars = snapshotPendingChars;
		session.commitTaskId = result.task_id;

		if (!result.task_id) {
			finalizeCommitSuccess(session, null);
			return {
				session_id: session.ovSessionId,
				status: "completed",
				pending_chars: session.pendingChars,
				tracked: true,
			};
		}

		if (options.waitForCompletion) {
			const task = await waitForCommitCompletion(session, options.signal);
			return {
				session_id: session.ovSessionId,
				status:
					task?.status === "completed"
						? "completed"
						: task?.status === "failed"
							? "failed"
							: "accepted",
				task_id: result.task_id,
				task,
				pending_chars: session.pendingChars,
				tracked: true,
			};
		}

		return {
			session_id: session.ovSessionId,
			status: "accepted",
			task_id: result.task_id,
			pending_chars: session.pendingChars,
			tracked: true,
		};
	} catch (err) {
		// Auto-recover from failed archive (e.g., commit was cancelled by reload)
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("unresolved failed archive")) {
			try {
				await client.clearFailedArchive(session.ovSessionId);
				// Silently recovered — no user-visible log
				const retry = await client.commit(session.ovSessionId, options.signal);
				session.commitPendingChars = snapshotPendingChars;
				session.commitTaskId = retry.task_id;
				return {
					session_id: session.ovSessionId,
					status: "accepted",
					task_id: retry.task_id,
					pending_chars: session.pendingChars,
					tracked: true,
				};
			} catch (retryErr) {
				// Silently failed — will retry on next commit cycle
				session.pendingChars = snapshotPendingChars;
				return {
					session_id: session.ovSessionId,
					status: "failed",
					pending_chars: session.pendingChars,
					tracked: true,
				};
			}
		}
		console.error("[openviking] Commit failed:", err);
		session.pendingChars = snapshotPendingChars;
		return {
			session_id: session.ovSessionId,
			status: "failed",
			pending_chars: session.pendingChars,
			tracked: true,
		};
	}
}

async function shouldAutoCommit(session: SessionState, signal?: AbortSignal) {
	const config = getConfig();
	const pendingTokens = await getPendingTokens(session, signal);
	if (typeof pendingTokens === "number") {
		return pendingTokens >= config.autoCommit.tokenThreshold;
	}
	return session.pendingChars > config.autoCommit.tokenThreshold;
}

async function getPendingTokens(session: SessionState, signal?: AbortSignal) {
	try {
		const info = await getClient().getSession(session.ovSessionId, signal);
		return typeof info.pending_tokens === "number" ? info.pending_tokens : null;
	} catch {
		return null;
	}
}

async function pollCommitTask(session: SessionState, signal?: AbortSignal): Promise<OVTask | null> {
	if (!session.commitTaskId) return session.lastTask ?? null;
	try {
		const task = await getClient().getTask(session.commitTaskId, signal, 5000);
		session.lastTask = task;
		if (task.status === "completed") {
			finalizeCommitSuccess(session, task);
		}
		if (task.status === "failed") {
			finalizeCommitFailure(session, task);
		}
		return task;
	} catch (err: any) {
		const msg = err?.message ?? String(err);
		if (msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("resource not found")) {
			console.warn("[openviking] Commit task disappeared, clearing stale state:", session.commitTaskId);
			finalizeCommitFailure(session, null);
			return null;
		}
		console.error("[openviking] Commit task poll failed:", err);
		return session.lastTask ?? null;
	}
}

async function waitForCommitCompletion(
	session: SessionState,
	signal?: AbortSignal,
	timeoutMs = 30_000,
): Promise<OVTask | null> {
	const startedAt = Date.now();
	while (session.commitTaskId && Date.now() - startedAt < timeoutMs) {
		const task = await pollCommitTask(session, signal);
		if (!session.commitTaskId || task?.status === "completed" || task?.status === "failed") {
			return task;
		}
		await sleep(2_000, signal);
	}
	return session.lastTask ?? null;
}

async function waitForTask(
	client: OpenVikingClient,
	taskId: string,
	signal?: AbortSignal,
	timeoutMs = 30_000,
): Promise<OVTask | null> {
	const startedAt = Date.now();
	let lastTask: OVTask | null = null;
	while (Date.now() - startedAt < timeoutMs) {
		const task = await client.getTask(taskId, signal, 5000);
		lastTask = task;
		if (task.status === "completed" || task.status === "failed") return task;
		await sleep(2_000, signal);
	}
	return lastTask;
}

function finalizeCommitSuccess(session: SessionState, task: OVTask | null) {
	const committedChars = session.commitPendingChars ?? session.pendingChars;
	session.pendingChars = Math.max(0, session.pendingChars - committedChars);
	session.commitTaskId = undefined;
	session.commitPendingChars = undefined;
	session.lastTask = task;
	invalidateSessionOverview(session.ovSessionId);
}

function finalizeCommitFailure(session: SessionState, task: OVTask | null) {
	session.commitTaskId = undefined;
	session.commitPendingChars = undefined;
	session.lastTask = task;
}

function getClient() {
	if (!sharedClient) {
		throw new Error("OpenViking session client is not initialized");
	}
	return sharedClient;
}

function getConfig() {
	if (!sharedConfig) {
		throw new Error("OpenViking session config is not initialized");
	}
	return sharedConfig;
}

async function sleep(ms: number, signal?: AbortSignal) {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		if (!signal) return;
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Operation aborted"));
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** 只剔除 OV 自己注入的内容，避免循环污染。其余原样透传。 */
function stripPollution(text: string): string {
	return text
		.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, "")
		.replace(/<openviking-context>[\s\S]*?<\/openviking-context>/g, "")
		.trim();
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return String(content ?? "");
	const parts: string[] = [];
	for (const c of content as Array<Record<string, unknown>>) {
		if (c.type === "text" && typeof c.text === "string") {
			parts.push(c.text);
		} else if (c.type === "toolCall" && typeof c.name === "string") {
			parts.push(`[ToolCall: ${c.name}]`);
		} else if (c.type === "thinking" && typeof c.thinking === "string") {
			parts.push(c.thinking);
		}
	}
	return parts.filter(Boolean).join("\n");
}

function extractToolResultText(content: unknown, toolName?: string): string {
	if (!Array.isArray(content)) return String(content ?? "");
	const texts = (content as Array<Record<string, unknown>>)
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string);
	if (texts.length === 0) return "";
	const joined = texts.join("\n").trim();
	if (!joined) return "";
	const name = toolName ?? "unknown";
	return `[ToolResult: ${name}]\n${joined}`;
}

function isStaleCtxError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("extension ctx is stale");
}
