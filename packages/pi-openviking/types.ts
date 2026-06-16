/**
 * OpenViking Pi Extension — 类型定义
 */

export interface OpenVikingConfig {
	/** OpenViking HTTP 端点，默认 http://localhost:1933 */
	endpoint: string;
	/** API Key（可选） */
	apiKey: string;
	/** 租户账号，默认 default */
	account: string;
	/** 用户标识，默认 pi */
	user: string;
	/** Agent 标识 */
	agentId: string;
	/** 是否启用插件 */
	enabled: boolean;
	/** HTTP 请求超时（毫秒） */
	timeoutMs: number;
	/** 自动提交配置 */
	autoCommit: {
		enabled: boolean;
		/** 累积 token 阈值，超过后触发 commit */
		tokenThreshold: number;
	};
	/** 自动记忆召回配置 */
	 autoRecall: {
		 enabled: boolean;
		/** 是否使用 search() + IntentAnalyzer，默认 false（用 find()） */
		useSearch?: boolean;
		/** 最大召回数量 */
		limit: number;
		/** 基础相关性分数阈值（有效 token 充足时使用） */
		scoreThreshold: number;
		/** 单条记忆最大字符数 */
		maxContentChars: number;
		/** 优先使用摘要 */
		preferAbstract: boolean;
		/** 总 token 预算 */
		tokenBudget: number;
		/** 是否在对话中显示召回的记忆块（调试用），默认 false */
		display: boolean;
		/**
		 * 动态阈值策略：基于字符数 + 有效 token 数调整召回阈值。
		 * 有序数组，从上到下匹配第一个 chars >= minChars 的项：
		 *   - 如果该项有 minTokens 且 tokens < minTokens → 跳过召回
		 *   - 否则使用该项的 threshold
		 *   - chars < 第一项的 minChars → 跳过召回
		 * 不配或空数组 → 使用固定 scoreThreshold
		 */
		dynamicThreshold?: Array<{
			minChars: number;
			minTokens?: number;
			threshold: number;
		}>;
	};
	/** 显式搜索工具默认配置 */
	searchDefaults: {
		limit: number;
		scoreThreshold: number;
	};
	/** /prompt-opt 的上下文收敛配置 */
	promptOpt: {
		recallLimit: number;
		recallScoreThreshold: number;
		recallMode: "auto" | "fast" | "deep";
		systemPromptChars: number;
		recentMessages: number;
		perMessageChars: number;
		recallContentChars: number;
		temperature: number;
		maxTokens: number;
		timeoutMs: number;
	};
}

export interface OVResponse<T = unknown> {
	status: "ok" | "error";
	result?: T;
	error?: {
		code: string;
		message: string;
		details?: Record<string, unknown>;
	};
	time: number;
}

export interface OVSearchResult {
	uri: string;
	score: number;
	title?: string;
	abstract?: string;
	overview?: string | null;
	content?: string;
	level?: string | number;
	category?: string;
	context_type?: string;
	metadata?: Record<string, unknown>;
}

export interface OVFsEntry {
	name: string;
	uri: string;
	size: number;
	isDir: boolean;
	mode: number;
}

export interface OVSession {
	session_id: string;
	created_at: string;
	updated_at?: string;
	status?: string;
	pending_tokens?: number;
	metadata?: Record<string, unknown>;
}

export interface OVTask {
	task_id: string;
	type: string;
	status: "pending" | "running" | "completed" | "failed";
	created_at: string;
	updated_at?: string;
	error?: string;
	result?: unknown;
}
