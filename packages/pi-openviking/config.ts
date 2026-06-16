/**
 * OpenViking 配置加载
 *
 * 优先级（从高到低）：
 * 1. 环境变量：OPENVIKING_ENDPOINT, OPENVIKING_API_KEY, OPENVIKING_ACCOUNT, OPENVIKING_USER, OPENVIKING_AGENT_ID
 * 2. ~/.pi/agent/settings.json 中的 openviking 字段
 * 3. 默认值
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { OpenVikingConfig } from "./types.js";

const DEFAULT_CONFIG: OpenVikingConfig = {
	endpoint: "http://localhost:1933",
	apiKey: "",
	account: "default",
	user: "pi",
	agentId: "pi-agent",
	enabled: true,
	timeoutMs: 30000,
	autoCommit: {
		enabled: true,
		tokenThreshold: 20000,
	},
	autoRecall: {
		 enabled: true,
		 useSearch: false,
		 limit: 4,
		 scoreThreshold: 0.55,
		 maxContentChars: 280,
		 preferAbstract: true,
		 tokenBudget: 1200,
		 display: false,
		 dynamicThreshold: [
			 { minChars: 4, minTokens: 2, threshold: 0.78 },
			 { minChars: 9, threshold: 0.73 },
			 { minChars: 16, threshold: 0.70 },
			 { minChars: 31, threshold: 0.67 },
		 ],
	},
	searchDefaults: {
		limit: 8,
		scoreThreshold: 0.5,
	},
	promptOpt: {
		recallLimit: 2,
		recallScoreThreshold: 0.58,
		recallMode: "fast",
		systemPromptChars: 900,
		recentMessages: 4,
		perMessageChars: 300,
		recallContentChars: 160,
		temperature: 0.2,
		maxTokens: 2048,
		timeoutMs: 20000,
	},
};

function env(key: string): string | undefined {
	return process.env[key];
}

function envBool(key: string): boolean | undefined {
	const value = env(key)?.trim().toLowerCase();
	if (value === "true" || value === "1" || value === "yes" || value === "on") return true;
	if (value === "false" || value === "0" || value === "no" || value === "off") return false;
	return undefined;
}

function loadFromSettings(): Partial<OpenVikingConfig> | null {
	try {
		const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
		if (!existsSync(settingsPath)) return null;
		const raw = readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw);
		return (parsed.openviking as Partial<OpenVikingConfig>) ?? null;
	} catch (err) {
		console.warn("[openviking] Failed to parse settings.json:", err instanceof Error ? err.message : String(err));
		return null;
	}
}


export function loadConfig(): OpenVikingConfig {
	const fromSettings = loadFromSettings() ?? {};

	// merge: settings.json > defaults
	const merged: Partial<OpenVikingConfig> = {
		...fromSettings,
	};

	return {
		endpoint:
			env("OPENVIKING_ENDPOINT") ??
			merged.endpoint ??
			DEFAULT_CONFIG.endpoint,
		apiKey:
			env("OPENVIKING_API_KEY") ?? merged.apiKey ?? DEFAULT_CONFIG.apiKey,
		account:
			env("OPENVIKING_ACCOUNT") ?? merged.account ?? DEFAULT_CONFIG.account,
		user: env("OPENVIKING_USER") ?? merged.user ?? DEFAULT_CONFIG.user,
		agentId:
			env("OPENVIKING_AGENT_ID") ?? merged.agentId ?? DEFAULT_CONFIG.agentId,
		enabled: merged.enabled ?? DEFAULT_CONFIG.enabled,
		timeoutMs: merged.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
		autoCommit: { ...DEFAULT_CONFIG.autoCommit, ...merged.autoCommit },
		autoRecall: {
			...DEFAULT_CONFIG.autoRecall,
			...merged.autoRecall,
			useSearch:
				envBool("OPENVIKING_RECALL_USE_SEARCH") ??
				merged.autoRecall?.useSearch ??
				DEFAULT_CONFIG.autoRecall.useSearch,
			display:
				envBool("OPENVIKING_RECALL_DISPLAY") ??
				merged.autoRecall?.display ??
				DEFAULT_CONFIG.autoRecall.display,
		},
		searchDefaults: {
			...DEFAULT_CONFIG.searchDefaults,
			...merged.searchDefaults,
		},
		promptOpt: {
			...DEFAULT_CONFIG.promptOpt,
			...merged.promptOpt,
		},
	};
}
