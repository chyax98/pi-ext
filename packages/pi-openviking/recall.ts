/**
 * OpenViking 自动记忆召回
 *
 * 在 before_agent_start 事件里，用用户消息做语义搜索，
 * 将相关记忆注入到 LLM context 中（display: false，用户不可见）。
 *
 * 对齐官方插件设计：
 * - 全局搜索（不加 target_uri 限制）
 * - query-aware ranking
 * - 叶子内容优先
 * - 去重 + token budget 控制
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OpenVikingClient } from "./client.js";
import type { OpenVikingConfig, OVSearchResult } from "./types.js";
import { getOvSessionIdFromContext } from "./session-registry.js";

const RECALL_TOKEN_RE = /[\p{L}\p{N}_-]+/gu;
const RECALL_STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"to",
	"of",
	"and",
	"or",
	"for",
	"in",
	"on",
	"with",
	"is",
	"are",
	"was",
	"were",
	"我",
	"你",
	"他",
	"她",
	"它",
	"我们",
	"你们",
	"他们",
	"这",
	"那",
	"一个",
	"一些",
	"一下",
	"怎么",
	"什么",
	"如何",
	"关于",
]);
const PREFERENCE_QUERY_RE = /prefer|preference|habit|style|like|dislike|偏好|习惯|风格|喜欢|不喜欢|要求/i;
const TEMPORAL_QUERY_RE = /when|what time|date|day|month|year|yesterday|today|tomorrow|last|next|什么时候|何时|哪天|几月|几年|昨天|今天|明天|上周|下周|上个月|下个月|去年|明年/i;

interface RecallQueryProfile {
	tokens: string[];
	wantsPreference: boolean;
	wantsTemporal: boolean;
}

/** 动态阈值：硬性最低下限，任何情况不低于此值。 */
const HARD_FLOOR_THRESHOLD = 0.65;

/**
 * 动态阈值计算。
 *
 * 策略：短 query → 高阈值（信息不足，宁可不放）；
 *       长 query → 阈值可适度降低（语义更明确，误匹配概率低）。
 * 但任何情况不低于 HARD_FLOOR_THRESHOLD。
 *
 * rules 是有序数组，每项代表一个 chars 区间 [minChars, nextMinChars):
 *   - 找到 chars 落入的区间（rule.minChars <= chars < nextRule.minChars）
 *   - 如果区间有 minTokens 且 tokens < minTokens → SKIP
 *   - 否则 → 使用 max(rule.threshold, HARD_FLOOR_THRESHOLD)
 *   - chars < 第一项的 minChars → SKIP
 * 不配 dynamicThreshold → return baseThreshold
 */
function computeDynamicThreshold(
	 charCount: number,
	 tokenCount: number,
	 baseThreshold: number,
	 rules: OpenVikingConfig["autoRecall"]["dynamicThreshold"],
): number | null {
	if (!rules || rules.length === 0) return Math.max(baseThreshold, HARD_FLOOR_THRESHOLD);

	// 找 chars 落入的区间
	for (let i = 0; i < rules.length; i++) {
		const rule = rules[i];
		const ceiling = i + 1 < rules.length ? rules[i + 1].minChars : Infinity;

		if (charCount >= rule.minChars && charCount < ceiling) {
			if (rule.minTokens != null && tokenCount < rule.minTokens) return null;
			return Math.max(rule.threshold, HARD_FLOOR_THRESHOLD);
		}
	}

	return null;
}

const sessionOverviewCache = new Map<string, string>();

export function invalidateSessionOverview(ovSessionId: string): void {
	sessionOverviewCache.delete(ovSessionId);
}

export function setupRecall(pi: ExtensionAPI, config: OpenVikingConfig) {
	if (!config.autoRecall.enabled) return;

	const client = new OpenVikingClient(config);
	const recallCfg = config.autoRecall;

	// Session context cache: latest archive overview per OV session.
	// Only needed for useSearch=true (search() + IntentAnalyzer path).
	const OVERVIEW_MAX_CHARS = 500;

	async function refreshSessionOverview(ctx: unknown) {
		const ovSessionId = getOvSessionIdFromContext(ctx);
		if (!ovSessionId) return;
		if (sessionOverviewCache.has(ovSessionId)) return;
		const overview = await client.getSessionOverview(ovSessionId);
		if (overview) sessionOverviewCache.set(ovSessionId, overview.slice(0, OVERVIEW_MAX_CHARS));
	}

	if (recallCfg.useSearch) {
		pi.on("session_start", async (_event, ctx) => {
			await refreshSessionOverview(ctx);
		});
	}

		pi.on("before_agent_start", async (event, _ctx) => {
		const rawQuery = event.prompt;
		if (!rawQuery || rawQuery.trim().length < 3) return;

		const queryProfile = buildRecallQueryProfile(rawQuery);
		const effectiveTokenCount = queryProfile.tokens.length;

		const dynamicThreshold = computeDynamicThreshold(
			rawQuery.length,
			effectiveTokenCount,
			recallCfg.scoreThreshold,
			recallCfg.dynamicThreshold,
		);

		if (dynamicThreshold === null) return;

		// Session context: only used by search() mode
		const ovSessionId = getOvSessionIdFromContext(_ctx);
		const useSearch = recallCfg.useSearch === true && ovSessionId;
		const overview = useSearch && ovSessionId
			? sessionOverviewCache.get(ovSessionId)
			: undefined;
		const query = overview
			? `${rawQuery}\n[session context] ${overview}`
			: rawQuery;

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 8_000);

			let results: OVSearchResult[] = [];
				try {
				if (useSearch) {
					results = await client.search(
						{
							query,
							session_id: ovSessionId!,
							limit: recallCfg.limit * 4,
							score_threshold: dynamicThreshold,
						},
						controller.signal,
					);
				} else {
					results = await client.find(
						{
							query,
							limit: recallCfg.limit * 4,
							score_threshold: dynamicThreshold,
						},
						controller.signal,
					);
				}
			} finally {
				clearTimeout(timeoutId);
			}

			if (!results || results.length === 0) return;

			const picked = pickMemoriesForInjection(
				results,
				recallCfg.limit,
				rawQuery,
				dynamicThreshold,
			);
			if (picked.length === 0) return;

			const formatted = formatMemoryBlock(
				postProcessMemories(
					picked,
					recallCfg.maxContentChars,
					recallCfg.preferAbstract,
				),
				recallCfg.tokenBudget,
			);
			if (!formatted) return;

			if (ovSessionId) {
				client.recordUsed(ovSessionId, picked.map((m) => m.uri), controller.signal).catch(() => {});
			}

			return {
				message: {
					customType: "openviking-recall",
					content: [{ type: "text", text: formatted }],
					display: recallCfg.display,
				},
			};
		} catch (error) {
			if (isStaleCtxError(error)) return;
			return;
		}
	});
}

function isStaleCtxError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("extension ctx is stale");
}

function buildRecallQueryProfile(query: string): RecallQueryProfile {
	const text = query.trim();
	const allTokens = text.toLowerCase().match(RECALL_TOKEN_RE) ?? [];
	const tokens = allTokens.filter((token) => !RECALL_STOPWORDS.has(token));
	return {
		tokens,
		wantsPreference: PREFERENCE_QUERY_RE.test(text),
		wantsTemporal: TEMPORAL_QUERY_RE.test(text),
	};
}

function lexicalOverlapBoost(tokens: string[], text: string): number {
	if (tokens.length === 0 || !text) return 0;
	const haystack = ` ${text.toLowerCase()} `;
	let matched = 0;
	for (const token of tokens.slice(0, 8)) {
		if (haystack.includes(` ${token} `) || haystack.includes(token)) {
			matched += 1;
		}
	}
	return Math.min(0.2, (matched / Math.min(tokens.length, 4)) * 0.2);
}

function isEventMemory(item: OVSearchResult): boolean {
	const category = (item.category ?? "").toLowerCase();
	return category === "events" || item.uri.includes("/events/");
}

function isPreferencesMemory(item: OVSearchResult): boolean {
	const category = (item.category ?? "").toLowerCase();
	return category === "preferences" || item.uri.includes("/preferences/");
}

function isLeafLikeMemory(item: OVSearchResult): boolean {
	return item.level === 2 || item.level === "2";
}

function clampScore(score: number | undefined): number {
	if (typeof score !== "number" || Number.isNaN(score)) return 0;
	return Math.max(0, Math.min(1, score));
}

function rankForInjection(item: OVSearchResult, query: RecallQueryProfile): number {
	const abstract = (item.abstract ?? item.overview ?? "").trim();
	const leafBoost = isLeafLikeMemory(item) ? 0.12 : 0;
	const eventBoost = query.wantsTemporal && isEventMemory(item) ? 0.1 : 0;
	const preferenceBoost = query.wantsPreference && isPreferencesMemory(item) ? 0.08 : 0;
	const overlapBoost = lexicalOverlapBoost(query.tokens, `${item.uri} ${abstract}`);
	return clampScore(item.score) + leafBoost + eventBoost + preferenceBoost + overlapBoost;
}

function normalizeDedupeText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isEventOrCaseMemory(item: OVSearchResult): boolean {
	const category = (item.category ?? "").toLowerCase();
	const uri = item.uri.toLowerCase();
	return category === "events" || category === "cases" || uri.includes("/events/") || uri.includes("/cases/");
}

function getMemoryDedupeKey(item: OVSearchResult): string {
	const abstract = normalizeDedupeText(item.abstract ?? item.overview ?? "");
	const category = (item.category ?? "").toLowerCase() || "unknown";
	if (abstract && !isEventOrCaseMemory(item)) {
		return `abstract:${category}:${abstract}`;
	}
	return `uri:${item.uri}`;
}

function pickMemoriesForInjection(
	items: OVSearchResult[],
	limit: number,
	queryText: string,
	scoreThreshold: number,
): OVSearchResult[] {
	if (items.length === 0 || limit <= 0) return [];

	const query = buildRecallQueryProfile(queryText);
	const sorted = [...items].sort((a, b) => rankForInjection(b, query) - rankForInjection(a, query));

	const deduped: OVSearchResult[] = [];
	const seen = new Set<string>();
	for (const item of sorted) {
		if (clampScore(item.score) < scoreThreshold) continue;
		const key = getMemoryDedupeKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(item);
	}

	const leaves = deduped.filter((item) => isLeafLikeMemory(item));
	if (leaves.length >= limit) return leaves.slice(0, limit);

	const picked = [...leaves];
	const used = new Set(leaves.map((item) => item.uri));
	for (const item of deduped) {
		if (picked.length >= limit) break;
		if (used.has(item.uri)) continue;
		picked.push(item);
	}
	return picked;
}

function postProcessMemories(
	items: OVSearchResult[],
	maxContentChars: number,
	preferAbstract: boolean,
): OVSearchResult[] {
	return items.map((item) => {
		const abstract = (item.abstract ?? "").trim();
		const content = (item.content ?? "").trim();
		let displayContent = "";
		if (preferAbstract && abstract) {
			displayContent = truncate(abstract, maxContentChars);
		} else if (content) {
			displayContent = truncate(content, maxContentChars);
		} else if (abstract) {
			displayContent = truncate(abstract, maxContentChars);
		}
		return { ...item, content: displayContent, abstract: abstract || undefined };
	});
}

function formatMemoryBlock(items: OVSearchResult[], tokenBudget: number): string {
	if (items.length === 0) return "";

	const maxBlockChars = tokenBudget * 4;
	let usedChars = 0;
	const lines: string[] = ["<relevant-memories>"];

	for (const item of items) {
		const title = item.title ? `${item.title}\n` : "";
		const content = item.content ?? "";
		const entry = `<memory uri="${item.uri}" score="${clampScore(item.score).toFixed(3)}">\n${title}${content}\n</memory>`;
		const entryChars = entry.length + 1;
		if (usedChars + entryChars > maxBlockChars) break;
		lines.push(entry);
		usedChars += entryChars;
	}

	if (usedChars === 0) return "";
	lines.push("</relevant-memories>");
	lines.push("Use memread with a memory URI to inspect more detail when needed.");
	return lines.join("\n");
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}
