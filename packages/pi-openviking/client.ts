/**
 * OpenViking HTTP 客户端封装
 */
import type {
	OpenVikingConfig,
	OVFsEntry,
	OVResponse,
	OVSearchResult,
	OVSession,
	OVTask,
} from "./types.js";

const MAX_BATCH_MESSAGES = 100;

export class OpenVikingClient {
	private readonly endpoint: string;
	private readonly headers: Record<string, string>;
	private readonly timeoutMs: number;

	constructor(config: OpenVikingConfig) {
		this.endpoint = config.endpoint.replace(/\/$/, "");
		this.timeoutMs = config.timeoutMs;
		this.headers = {
			"Content-Type": "application/json",
		};
		if (config.apiKey) {
			this.headers.Authorization = `Bearer ${config.apiKey}`;
			this.headers["X-API-Key"] = config.apiKey;
		}
		if (config.account) this.headers["X-OpenViking-Account"] = config.account;
		if (config.user) this.headers["X-OpenViking-User"] = config.user;
		if (config.agentId) this.headers["X-OpenViking-Agent"] = config.agentId;
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
		timeoutMs = this.timeoutMs,
	): Promise<T> {
		const url = `${this.endpoint}${path}`;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
		const abortListener = () => controller.abort();

		if (signal) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener("abort", abortListener, { once: true });
		}

		try {
			const res = await fetch(url, {
				method,
				headers: this.headers,
				body: body ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
			const raw = await res.text();
			const data = parseResponseBody(raw);
			if (!res.ok) {
				throw new Error(getResponseErrorMessage(data, res.status));
			}
			if (isErrorResponse(data)) {
				throw new Error(data.error?.message ?? "OpenViking request failed");
			}
			if (isWrappedResponse(data)) {
				return data.result as T;
			}
			return data as T;
		} finally {
			clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", abortListener);
		}
	}

	async getSessionOverview(sessionId: string, signal?: AbortSignal): Promise<string> {
		try {
			const result = await this.request<Record<string, unknown>>(
				"GET",
				`/api/v1/sessions/${encodeURIComponent(sessionId)}/context?token_budget=8000`,
				undefined,
				signal,
			);
			return typeof result?.latest_archive_overview === "string"
				? result.latest_archive_overview
				: "";
		} catch {
			return "";
		}
	}

	async find(
		params: {
			query: string;
			target_uri?: string;
			mode?: "auto" | "fast" | "deep";
			limit?: number;
			score_threshold?: number;
			filter?: Record<string, unknown>;
		},
		signal?: AbortSignal,
	): Promise<OVSearchResult[]> {
		const result = await this.request<unknown>(
			"POST",
			"/api/v1/search/find",
			params,
			signal,
		);
		return normalizeSearchResults(result);
	}

	async search(
		params: {
			query: string;
			session_id?: string;
			target_uri?: string;
			limit?: number;
			score_threshold?: number;
		},
		signal?: AbortSignal,
	): Promise<OVSearchResult[]> {
		const result = await this.request<unknown>(
			"POST",
			"/api/v1/search/search",
			params,
			signal,
		);
		return normalizeSearchResults(result);
	}

	async grep(
		params: {
			pattern: string;
			uri?: string;
			target_uri?: string;
			limit?: number;
		},
		signal?: AbortSignal,
	): Promise<Array<{ uri: string; line?: number; content?: string }>> {
		const result = await this.request<unknown>(
			"POST",
			"/api/v1/search/grep",
			{
				pattern: params.pattern,
				uri: params.uri ?? params.target_uri,
				limit: params.limit,
			},
			signal,
		);
		return normalizeGrepMatches(result);
	}

	async glob(
		params: {
			pattern: string;
			uri?: string;
			target_uri?: string;
			limit?: number;
		},
		signal?: AbortSignal,
	): Promise<string[]> {
		const result = await this.request<unknown>(
			"POST",
			"/api/v1/search/glob",
			{
				pattern: params.pattern,
				uri: params.uri ?? params.target_uri,
				limit: params.limit,
			},
			signal,
		);
		return normalizeGlobMatches(result);
	}

	async read(uri: string, signal?: AbortSignal): Promise<string> {
		const encoded = encodeURIComponent(uri);
		return this.request<string>("GET", `/api/v1/content/read?uri=${encoded}`, undefined, signal);
	}

	async abstract(uri: string, signal?: AbortSignal): Promise<string> {
		const encoded = encodeURIComponent(uri);
		return this.request<string>(
			"GET",
			`/api/v1/content/abstract?uri=${encoded}`,
			undefined,
			signal,
		);
	}

	async overview(uri: string, signal?: AbortSignal): Promise<string> {
		const encoded = encodeURIComponent(uri);
		return this.request<string>(
			"GET",
			`/api/v1/content/overview?uri=${encoded}`,
			undefined,
			signal,
		);
	}

	async ls(uri: string, signal?: AbortSignal): Promise<OVFsEntry[]> {
		const encoded = encodeURIComponent(uri);
		return this.request<OVFsEntry[]>("GET", `/api/v1/fs/ls?uri=${encoded}`, undefined, signal);
	}

	async tree(uri: string, signal?: AbortSignal): Promise<OVFsEntry[]> {
		const encoded = encodeURIComponent(uri);
		return this.request<OVFsEntry[]>("GET", `/api/v1/fs/tree?uri=${encoded}`, undefined, signal);
	}

	async stat(uri: string, signal?: AbortSignal): Promise<OVFsEntry> {
		const encoded = encodeURIComponent(uri);
		return this.request<OVFsEntry>("GET", `/api/v1/fs/stat?uri=${encoded}`, undefined, signal);
	}

	async mkdir(
		uri: string,
		description?: string,
		signal?: AbortSignal,
	): Promise<{ uri: string }> {
		return this.request<{ uri: string }>(
			"POST",
			"/api/v1/fs/mkdir",
			{ uri, description },
			signal,
		);
	}

	async createSession(
		params?: { id?: string; metadata?: Record<string, unknown> },
		signal?: AbortSignal,
	): Promise<OVSession> {
		const body: Record<string, unknown> = {};
		if (params?.id) body.session_id = params.id;
		if (params?.metadata) body.metadata = params.metadata;
		return this.request<OVSession>("POST", "/api/v1/sessions", body, signal);
	}

	async getSession(sessionId: string, signal?: AbortSignal): Promise<OVSession> {
		return this.request<OVSession>(
			"GET",
			`/api/v1/sessions/${encodeURIComponent(sessionId)}`,
			undefined,
			signal,
		);
	}

	async deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
		await this.request<void>(
			"DELETE",
			`/api/v1/sessions/${encodeURIComponent(sessionId)}`,
			undefined,
			signal,
		);
	}

	async commit(
		sessionId: string,
		signal?: AbortSignal,
	): Promise<{ task_id: string; memories_extracted?: number }> {
		return this.request<{ task_id: string; memories_extracted?: number }>(
			"POST",
			`/api/v1/sessions/${sessionId}/commit`,
			{},
		signal,
		);
	}

	/**
	 * Clear all failed archive markers (.failed.json) for a session,
	 * allowing the session to be committed again.
	 */
	async clearFailedArchive(sessionId: string): Promise<void> {
		const { readdirSync, rmSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { homedir } = await import("node:os");

		const historyDir = join(
			homedir(),
			".openviking",
			"workspace",
			"viking",
			"default",
			"session",
			sessionId,
			"history",
		);

		try {
			const archives = readdirSync(historyDir, { withFileTypes: true });
			for (const entry of archives) {
				if (entry.isDirectory() && !entry.name.startsWith(".")) {
					const failedPath = join(historyDir, entry.name, ".failed.json");
					try {
						rmSync(failedPath, { force: true });
					} catch {
						// ignore
					}
				}
			}
		} catch {
			// history dir may not exist
		}
	}

	async addMessage(
		sessionId: string,
		role: "user" | "assistant" | "system",
		content: string,
		signal?: AbortSignal,
	): Promise<void> {
		await this.request<void>(
			"POST",
			`/api/v1/sessions/${sessionId}/messages`,
			{ role, content },
			signal,
		);
	}

	async batchAddMessages(
		sessionId: string,
		messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
		signal?: AbortSignal,
	): Promise<void> {
		if (messages.length === 0) return;
		for (let i = 0; i < messages.length; i += MAX_BATCH_MESSAGES) {
			await this.request<void>(
				"POST",
				`/api/v1/sessions/${sessionId}/messages/batch`,
				{ messages: messages.slice(i, i + MAX_BATCH_MESSAGES) },
				signal,
			);
		}
	}

	async recordUsed(
		sessionId: string,
		contexts: string[],
		signal?: AbortSignal,
	): Promise<void> {
		if (contexts.length === 0) return;
		await this.request<void>(
			"POST",
			`/api/v1/sessions/${sessionId}/used`,
			{ contexts },
			signal,
		);
	}

	async write(
		params: {
			uri: string;
			content: string;
			mode?: "create" | "replace" | "append";
			wait?: boolean;
			timeout?: number;
		},
		signal?: AbortSignal,
	): Promise<{
		uri: string;
		root_uri?: string;
		context_type?: string;
		mode?: string;
		written_bytes?: number;
		content_updated?: boolean;
		semantic_status?: string;
		vector_status?: string;
		queue_status?: Record<string, unknown>;
	}> {
		return this.request(
			"POST",
			"/api/v1/content/write",
			{
				uri: params.uri,
				content: params.content,
				mode: params.mode ?? "replace",
				wait: params.wait ?? true,
				timeout: params.timeout,
			},
			signal,
			Math.max(this.timeoutMs, ((params.timeout ?? 120) + 10) * 1000),
		);
	}

	async addMemory(
		content: string,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		return this.request<Record<string, unknown>>(
			"POST",
			"/api/v1/memories/add",
			{ content },
			signal,
		);
	}

	async reindex(
		params: { uri: string; wait?: boolean },
		signal?: AbortSignal,
	): Promise<{ status?: string; message?: string }> {
		return this.request<{ status?: string; message?: string }>(
			"POST",
			"/api/v1/content/reindex",
			{
				uri: params.uri,
				wait: params.wait ?? true,
			},
			signal,
			Math.max(this.timeoutMs, 130000),
		);
	}

	async status(signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.request<Record<string, unknown>>(
			"GET",
			"/api/v1/system/status",
			undefined,
			signal,
		);
	}

	async health(signal?: AbortSignal): Promise<{ status: string }> {
		return this.request<{ status: string }>("GET", "/health", undefined, signal);
	}

	async getTask(
		taskId: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<OVTask> {
		return this.request<OVTask>(
			"GET",
			`/api/v1/tasks/${taskId}`,
			undefined,
			signal,
			timeoutMs,
		);
	}

	async listTasks(signal?: AbortSignal): Promise<OVTask[]> {
		return this.request<OVTask[]>("GET", "/api/v1/tasks", undefined, signal);
	}
}

function parseResponseBody(raw: string): unknown {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return raw;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isWrappedResponse<T>(value: unknown): value is OVResponse<T> & Record<string, unknown> {
	return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "result");
}

function isErrorResponse(
	value: unknown,
): value is OVResponse<unknown> & { error?: { message?: string } } {
	return isRecord(value) && value.status === "error";
}

function getResponseErrorMessage(data: unknown, status: number): string {
	if (typeof data === "string" && data.trim()) return `${data.trim()} (HTTP ${status})`;
	if (isErrorResponse(data)) {
		return data.error?.message ?? `HTTP ${status}`;
	}
	return `HTTP ${status}`;
}

function normalizeSearchResults(result: unknown): OVSearchResult[] {
	if (Array.isArray(result)) {
		return result as OVSearchResult[];
	}
	if (!isRecord(result)) {
		return [];
	}

	const groups = ["memories", "resources", "skills", "results"]
		.flatMap((key) => {
			const items = result[key];
			return Array.isArray(items) ? (items as OVSearchResult[]) : [];
		})
		.filter((item) => item && typeof item.uri === "string");

	return groups.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function normalizeGrepMatches(
	result: unknown,
): Array<{ uri: string; line?: number; content?: string }> {
	if (Array.isArray(result)) {
		return result as Array<{ uri: string; line?: number; content?: string }>;
	}
	if (!isRecord(result) || !Array.isArray(result.matches)) {
		return [];
	}
	return result.matches.filter(
		(match): match is { uri: string; line?: number; content?: string } =>
			isRecord(match) && typeof match.uri === "string",
	);
}

function normalizeGlobMatches(result: unknown): string[] {
	if (Array.isArray(result)) {
		return result.filter((item): item is string => typeof item === "string");
	}
	if (!isRecord(result) || !Array.isArray(result.matches)) {
		return [];
	}
	return result.matches.filter((item): item is string => typeof item === "string");
}
