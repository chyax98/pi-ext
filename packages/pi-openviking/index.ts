/**
 * OpenViking Pi Extension
 *
 * 三层能力：
 * 1. Tools（高价值显式工具）
 * 2. Auto Recall — 已关闭，改为手动 /recall
 * 3. Session Sync — 对话 → 长期记忆同步
 * 4. /prompt-opt — 上下文感知提示词优化
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { setupRecall } from "./recall.js";
import { setupSessionSync } from "./session.js";
import { registerTools } from "./tools.js";
import { OpenVikingClient } from "./client.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** 当前正在进行的 prompt-opt 请求，重复按键时取消前一个 */
let promptOptAbort: AbortController | null = null;

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	if (!config.enabled) {
		console.log("[openviking] Plugin disabled via config.");
		return;
	}

	registerTools(pi, config);
	setupRecall(pi, config);
	setupSessionSync(pi, config);

	// Abort in-flight prompt-opt on session shutdown/reload
	pi.on("session_shutdown", () => {
		if (promptOptAbort) {
			promptOptAbort.abort();
			promptOptAbort = null;
		}
	});

	function startOptimizing(ctx: any) {
		try {
			ctx.ui?.setWorkingMessage("Optimizing prompt...");
			ctx.ui?.setWorkingVisible(true);
		} catch {
			// ignore
		}
	}

	function stopOptimizing(ctx: any) {
		try {
			ctx.ui?.setWorkingVisible(false);
			ctx.ui?.setWorkingMessage();
		} catch {
			// ignore
		}
	}

	// /recall 命令：手动搜索记忆并注入到对话
	pi.registerCommand("recall", {
		description: "搜索 OpenViking 记忆并注入到当前对话",
		async handler(args, ctx) {
			const query = args.trim();
			if (!query) {
				safeNotify(ctx, "请输入搜索关键词：/recall <关键词>", "warning");
				return;
			}

			const client = new OpenVikingClient(config);
			try {
				const results = await client.find({
					query,
					mode: "auto",
					limit: config.autoRecall.limit,
					score_threshold: config.autoRecall.scoreThreshold,
				});

				if (!results || results.length === 0) {
					safeNotify(ctx, "未找到相关记忆", "info");
					return;
				}

				const lines = ["<relevant-memories>"];
				for (const item of results) {
					const title = item.title ? `${item.title}\n` : "";
					const content = item.abstract ?? item.overview ?? "";
					lines.push(`<memory uri="${item.uri}" score="${(item.score ?? 0).toFixed(3)}">\n${title}${content}\n</memory>`);
				}
				lines.push("</relevant-memories>");
				lines.push("Use memread with a memory URI to inspect more detail when needed.");
				const formatted = lines.join("\n");

				await safeSendMessage(ctx, {
					customType: "openviking-recall",
					content: [{ type: "text", text: formatted }],
					display: true,
				}, { triggerTurn: false });

				safeNotify(ctx, `已注入 ${results.length} 条记忆`, "info");
			} catch (e: any) {
				safeNotify(ctx, `搜索失败: ${e.message}`, "error");
			}
		},
	});

	// 快捷键：优化当前输入框中的提示词，结果回填到输入框
pi.registerShortcut("ctrl+alt+o", {
		description: "优化当前输入框中的提示词（带上下文召回 + 历史对话 + system prompt）",
		async handler(ctx) {
			const rawPrompt = (ctx.ui?.getEditorText() ?? "").trim();
			if (!rawPrompt) {
				safeNotify(ctx, "输入框为空，请先输入提示词", "warning");
				return;
			}

			// 取消上一个正在进行的优化
			if (promptOptAbort) {
				promptOptAbort.abort();
				promptOptAbort = null;
			}

			const ctrl = new AbortController();
			promptOptAbort = ctrl;
			startOptimizing(ctx);

			let fetchTimeout: NodeJS.Timeout | undefined;
			try {
			// 1. 读取 VLM 配置
			let vlmConfig: any = {};
			try {
				const ovConf = JSON.parse(readFileSync(resolve(homedir(), ".openviking", "ov.conf"), "utf-8"));
				vlmConfig = ovConf.vlm ?? {};
			} catch {
				safeNotify(ctx, "未找到 ov.conf VLM 配置", "error");
				return;
			}

			const apiBase = vlmConfig.api_base ?? "";
			const apiKey = vlmConfig.api_key ?? "";
			const model = vlmConfig.model ?? "gpt-5.4-mini";
			const promptCfg = config.promptOpt;
			if (!apiBase) {
				safeNotify(ctx, "ov.conf 缺少 VLM api_base 配置", "error");
				return;
			}

			// 2. 构建上下文
			// 2a. System prompt 摘要
			const sysPrompt = safeGetSystemPrompt(ctx);
			const sysSummary = sysPrompt.length > promptCfg.systemPromptChars ? sysPrompt.slice(0, promptCfg.systemPromptChars) + "\n..." : sysPrompt;

			// 2b. 近期对话历史
			let recentTurns = "";
			try {
				const branch = safeGetBranch(ctx);
				if (!branch) throw new Error("branch unavailable");
				const messages: Array<{ role: string; text: string }> = [];

				for (let i = branch.length - 1; i >= 0 && messages.length < promptCfg.recentMessages; i--) {
					const entry = branch[i] as any;
					if (entry.type === "message" && entry.message) {
						const msg = entry.message as any;
						const role = msg.role ?? "";
						let text = "";
						if (typeof msg.content === "string") {
							text = msg.content;
						} else if (Array.isArray(msg.content)) {
							text = msg.content.map((c: any) => c.text ?? c.thinking ?? "").join("\n");
						}
						if (text && (role === "user" || role === "assistant")) {
							messages.unshift({ role, text: text.slice(0, promptCfg.perMessageChars) });
						}
					}
				}

				if (messages.length > 0) {
					recentTurns = messages.map(m => `[${m.role}]\n${m.text}`).join("\n\n---\n\n");
				}
			} catch {
				// sessionManager 可能不可用，忽略
			}

			// 2c. OV 记忆召回（基于当前 prompt 内容）
			let ovMemories = "";
			try {
				const client = new OpenVikingClient(config);
				const results = await client.find({
					query: rawPrompt.slice(0, 200),
					mode: promptCfg.recallMode,
					limit: promptCfg.recallLimit,
					score_threshold: promptCfg.recallScoreThreshold,
				});
				if (results && results.length > 0) {
					ovMemories = results.map((r) => {
						const text = r.abstract ?? r.overview ?? "";
						return `- ${r.title ?? r.uri}: ${text.slice(0, promptCfg.recallContentChars)}`;
					}).join("\n");
				}
			} catch {
				// 召回失败不影响主流程
			}

			// 3. 组装 meta-prompt
			const contextBlocks: string[] = [];
			contextBlocks.push(`=== 当前会话约束（System Prompt 摘要） ===\n${sysSummary}`);
			if (recentTurns) {
				contextBlocks.push(`=== 近期对话（最近 ${Math.min(promptCfg.recentMessages, (recentTurns.match(/\[user\]/g) ?? []).length)} 轮） ===\n${recentTurns}`);
			}
			if (ovMemories) {
				contextBlocks.push(`=== 相关记忆（召回） ===\n${ovMemories}`);
			}

			const systemPrompt = `你是一名提示词优化专家。基于以下上下文，优化用户最后提供的提示词。

优化规则（优先级从高到低）：
1. 对齐：优化后的提示词必须与"当前会话约束"保持一致，不冲突
2. 中文：中文优先，英文仅保留代码、命令、API 名称、专有名词
3. 精简：高密度表达，去掉填充词和废话
4. 直接：可执行，禁止"如果你愿意/我可以/你要不要"等抛回式表达
5. 结构：约束清晰、输出格式明确、步骤可落地
6. 禁止：模板腔、销售腔、假客气、不是...而是...句式
7. 历史：考虑"近期对话"的上下文，不要重复已经确认的信息
8. 记忆：参考"相关记忆"中的用户偏好，融入优化结果

只输出优化后的提示词文本。不要解释、不要包装、不要总结。`;

			const userContent = `${contextBlocks.join("\n\n")}\n\n=== 用户待优化的提示词 ===\n${rawPrompt}`;

			// 4. 调用 nano
			try {
				fetchTimeout = setTimeout(() => ctrl.abort(), promptCfg.timeoutMs);
				const res = await fetch(`${apiBase}/chat/completions`, {
					method: "POST",
					signal: ctrl.signal,
					headers: {
						"Content-Type": "application/json",
						"Authorization": `Bearer ${apiKey}`,
					},
					body: JSON.stringify({
						model,
						messages: [
							{ role: "system", content: systemPrompt },
							{ role: "user", content: userContent },
						],
						temperature: promptCfg.temperature,
						max_tokens: promptCfg.maxTokens,
					}),
				});

				if (ctrl.signal.aborted) return;

				if (!res.ok) {
					const errText = await res.text();
					safeNotify(ctx, `优化请求失败: ${res.status} ${errText}`, "error");
					return;
				}

				const data = await res.json();
				const polished = data.choices?.[0]?.message?.content ?? "";

				if (ctrl.signal.aborted) return;

				// 5. 静默回填到输入框
				safeSetEditorText(ctx, polished);
				safeNotify(ctx, "提示词已优化并回填到输入框", "info");
			} catch (e: any) {
				if (e.name === "AbortError" || e.message?.includes("aborted")) return;
				safeNotify(ctx, `优化失败: ${e.message}`, "error");
			}

			} finally {
				clearTimeout(fetchTimeout);
				if (promptOptAbort === ctrl) promptOptAbort = null;
				stopOptimizing(ctx);
			}
		},
	});
}

function isStaleCtxError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("extension ctx is stale");
}

function safeNotify(ctx: any, message: string, level: "info" | "warning" | "error") {
	try {
		ctx.ui?.notify(message, level);
	} catch (error) {
		if (!isStaleCtxError(error)) throw error;
	}
}

async function safeSendMessage(ctx: any, payload: any, options?: any) {
	try {
		return await ctx.sendMessage(payload, options);
	} catch (error) {
		if (!isStaleCtxError(error)) throw error;
		return undefined;
	}
}

function safeSetEditorText(ctx: any, text: string) {
	try {
		ctx.ui?.setEditorText(text);
	} catch (error) {
		if (!isStaleCtxError(error)) throw error;
	}
}

function safeGetSystemPrompt(ctx: any): string {
	try {
		return ctx.getSystemPrompt();
	} catch (error) {
		if (isStaleCtxError(error)) return "";
		throw error;
	}
}

function safeGetBranch(ctx: any): any[] | null {
	try {
		return ctx.sessionManager?.getBranch?.() ?? null;
	} catch (error) {
		if (isStaleCtxError(error)) return null;
		throw error;
	}
}
