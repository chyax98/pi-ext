/**
 * OpenViking explicit tool surface.
 *
 * Keep only the user-facing memory primitives:
 * - memsearch: discover memory/resource URIs by semantic, exact, glob, or browse mode
 * - memread: read a concrete URI
 * - memadd: write curated durable memory/resource content
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { OpenVikingClient } from "./client.js";
import { getOvSessionIdFromContext } from "./session-registry.js";
import type { OpenVikingConfig, OVFsEntry } from "./types.js";

type SearchStrategy = "semantic" | "exact" | "glob" | "browse" | "tree" | "stat";

export function registerTools(pi: ExtensionAPI, config: OpenVikingConfig) {
	const client = new OpenVikingClient(config);

	pi.registerTool({
		name: "memsearch",
		label: "Memory Search",
		description: "Find OpenViking memories/resources. Use strategy:'semantic' for meaning, 'exact' for text/regex, 'glob' for URI patterns, or 'browse'/'tree'/'stat' for URI discovery.",
		promptSnippet: "Search OpenViking memory/resource space",
		promptGuidelines: [
			"Default to strategy:'semantic' when looking for relevant memories by meaning.",
			"Use strategy:'exact' when you know a literal keyword or regex; pass target_uri to narrow the subtree.",
			"Use strategy:'glob' when you know the path shape but not the exact URI.",
			"Use strategy:'browse', 'tree', or 'stat' only to discover concrete URIs before memread.",
			"Preference / rule / habit queries should prefer target_uri='viking://user/default/memories/'.",
			"Reference docs / notes queries should prefer target_uri='viking://resources/'.",
			"Do not finalize decisions from search hits alone. If a result matters, call memread on the concrete URI.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Semantic query, exact pattern, glob pattern, or URI depending on strategy" }),
			strategy: Type.Optional(
				Type.String({
					description: "semantic | exact | glob | browse | tree | stat. Default: semantic",
					default: "semantic",
				}),
			),
			target_uri: Type.Optional(
				Type.String({
					description: "Optional URI prefix/base, e.g. 'viking://user/default/memories/' or 'viking://resources/'",
				}),
			),
			mode: Type.Optional(
				Type.String({ description: "Semantic search mode: auto | fast | deep", default: "auto" }),
			),
			limit: Type.Optional(
				Type.Number({
					description: `Max results to return (default ${config.searchDefaults.limit})`,
					default: config.searchDefaults.limit,
				}),
			),
			score_threshold: Type.Optional(
				Type.Number({
					description: `Minimum relevance score for semantic search (0-1, default ${config.searchDefaults.scoreThreshold})`,
					default: config.searchDefaults.scoreThreshold,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const strategy = normalizeSearchStrategy(params.strategy);
			const limit = params.limit ?? config.searchDefaults.limit;

			if (strategy === "exact") {
				const matches = await client.grep(
					{
						pattern: params.query,
						uri: params.target_uri ?? "viking://user",
						limit,
					},
					signal,
				);
				return {
					content: [{ type: "text", text: formatGrepMatches(matches) }],
					details: { strategy, matches },
				};
			}

			if (strategy === "glob") {
				const resolved = resolveGlobInput(params.query, params.target_uri);
				const matches = await queryGlobWithFallback(client, resolved.pattern, resolved.uri, limit, signal);
				return {
					content: [{ type: "text", text: formatGlobMatches(matches) }],
					details: { strategy, matches, resolved },
				};
			}

			if (strategy === "browse" || strategy === "tree" || strategy === "stat") {
				const uri = params.target_uri ?? params.query;
				if (strategy === "stat") {
					const info = await client.stat(uri, signal);
					return {
						content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
						details: { strategy, info },
					};
				}
				const entries = strategy === "tree" ? await client.tree(uri, signal) : await client.ls(uri, signal);
				return {
					content: [{ type: "text", text: formatFsEntries(entries) }],
					details: { strategy, entries },
				};
			}

			const sessionId = getOvSessionIdFromContext(ctx);
			const semanticMode = resolveSearchMode(
				(params.mode as "auto" | "fast" | "deep" | undefined) ?? "auto",
				params.query,
				sessionId ?? undefined,
			);
			const threshold = params.score_threshold ?? config.searchDefaults.scoreThreshold;
			const request = {
				query: params.query,
				target_uri: params.target_uri,
				limit,
				score_threshold: threshold,
			};
			const results =
				semanticMode === "deep"
					? await client.search({ ...request, session_id: sessionId ?? undefined }, signal)
					: await client.find({ ...request, mode: semanticMode }, signal);
			return {
				content: [{ type: "text", text: formatSearchResults(results) }],
				details: { strategy, results, mode: semanticMode, session_id: sessionId ?? null, score_threshold: threshold },
			};
		},
	});

	pi.registerTool({
		name: "memread",
		label: "Memory Read",
		description: "Read one viking:// URI.",
		promptSnippet: "Read a memory or resource URI",
		promptGuidelines: [
			"Use after memsearch when you already have a concrete URI.",
			"Default level=auto. Use read for full content.",
			"If a search hit may affect implementation or a decision, read it before acting.",
			"Prefer reading exact leaf URIs instead of trusting only directory summaries.",
		],
		parameters: Type.Object({
			uri: Type.String({ description: "Target viking:// URI" }),
			level: Type.Optional(
				Type.String({
					description: "Detail level: abstract | overview | read | auto",
					default: "auto",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const requestedLevel = (params.level as "abstract" | "overview" | "read" | "auto") ?? "auto";
			const stat = await safeStat(client, params.uri, signal);

			if (requestedLevel === "auto") {
				const actualLevel: "abstract" | "overview" | "read" = stat?.isDir ? "overview" : "read";
				const content = await readByLevel(client, params.uri, actualLevel, signal);
				return {
					content: [{ type: "text", text: content }],
					details: {
						uri: params.uri,
						requested_level: requestedLevel as string,
						actual_level: actualLevel as string,
						fallback: actualLevel === "read" ? "read" : null,
						reason: stat ? null : "stat unavailable",
					} as Record<string, unknown>,
				};
			}

			try {
				const content = await readByLevel(client, params.uri, requestedLevel, signal);
				return {
					content: [{ type: "text", text: content }],
					details: {
						uri: params.uri,
						requested_level: requestedLevel as string,
						actual_level: requestedLevel as string,
						fallback: null,
						reason: null,
					} as Record<string, unknown>,
				};
			} catch (error) {
				if (stat && !stat.isDir && requestedLevel !== "read") {
					const fallback = await client.read(params.uri, signal);
					return {
						content: [{ type: "text", text: fallback }],
						details: {
							uri: params.uri,
							requested_level: requestedLevel as string,
							actual_level: "read",
							fallback: "read",
							reason: error instanceof Error ? error.message : String(error),
						} as Record<string, unknown>,
					};
				}
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "memadd",
		label: "Memory Add",
		description: "Write one curated memory/resource into OpenViking.",
		promptSnippet: "Store a curated note or preference in OpenViking",
		promptGuidelines: [
			// WHEN: only for durable knowledge
			"Use only for knowledge that will still matter next week. Not for session context, draft ideas, or unverified guesses.",
			// WHAT qualifies (memory lane)
			"memory lane: preferences, coding rules, workflow conventions, architectural decisions, verified facts, recurring patterns — things that should change agent behavior.",
			// WHAT qualifies (resource lane)
			"resource lane: reference docs, research notes, knowledge base material — consulted but don't actively shape decisions.",
			// FORMAT
			"Content: use clear headings, bullet lists for rules, include trigger/context (when does this apply?), keep it scannable.",
			"Default lane=memory writes to viking://user/default/memories/manual/<title>/<title>.md.",
			"Use lane=resource for material under viking://resources/manual/.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short title for the memory/resource" }),
			content: Type.String({ description: "Full content to store" }),
			lane: Type.Optional(Type.String({ description: "memory | resource", default: "memory" })),
			target_uri: Type.Optional(
				Type.String({ description: "Optional exact target file URI override. If omitted, extension derives one from lane + title." }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const lane = (params.lane as "memory" | "resource" | undefined) ?? "memory";
			const resolved = resolveManualWriteTarget(params.title, lane, params.target_uri);
			await client.mkdir(resolved.parentUri, `pi-openviking manual ${lane} lane`, signal);
			// Try replace first (existing files), fall back to create (new files)
			let result: Awaited<ReturnType<typeof client.write>>;
			try {
				result = await client.write(
					{
						uri: resolved.fileUri,
						content: params.content,
						mode: "replace",
						wait: true,
						timeout: lane === "memory" ? 180 : 120,
					},
					signal,
				);
			} catch (error) {
				if (
					error instanceof Error &&
					(error.message.includes("not found") || error.message.includes("File not found"))
				) {
					result = await client.write(
						{
							uri: resolved.fileUri,
							content: params.content,
							mode: "create",
							wait: true,
							timeout: lane === "memory" ? 180 : 120,
						},
						signal,
					);
				} else {
					throw error;
				}
			}
			return {
				content: [{ type: "text", text: formatMemAddResult(params.title, lane, resolved.fileUri, result) }],
				details: { lane, title: params.title, target: resolved, result },
			};
		},
	});
}

function normalizeSearchStrategy(input: unknown): SearchStrategy {
	if (input === "exact" || input === "grep") return "exact";
	if (input === "glob") return "glob";
	if (input === "browse" || input === "list" || input === "ls") return "browse";
	if (input === "tree") return "tree";
	if (input === "stat") return "stat";
	return "semantic";
}

async function readByLevel(
	client: OpenVikingClient,
	uri: string,
	level: "abstract" | "overview" | "read",
	signal?: AbortSignal,
): Promise<string> {
	switch (level) {
		case "abstract":
			return client.abstract(uri, signal);
		case "overview":
			return client.overview(uri, signal);
		case "read":
			return client.read(uri, signal);
	}
}

async function safeStat(client: OpenVikingClient, uri: string, signal?: AbortSignal): Promise<{ isDir: boolean } | null> {
	try {
		return await client.stat(uri, signal);
	} catch {
		return null;
	}
}

function resolveSearchMode(requestedMode: "auto" | "fast" | "deep", query: string, sessionId?: string): "fast" | "deep" {
	if (requestedMode === "fast" || requestedMode === "deep") return requestedMode;
	if (sessionId) return "deep";
	const normalized = query.trim();
	const wordCount = normalized ? normalized.split(/\s+/).length : 0;
	if (normalized.includes("?") || normalized.length >= 80 || wordCount >= 8) return "deep";
	return "fast";
}

function resolveGlobInput(pattern: string, uri?: string): { pattern: string; uri?: string } {
	if (uri || !pattern.startsWith("viking://")) return { pattern, uri };
	const withoutScheme = pattern.slice("viking://".length);
	const segments = withoutScheme.split("/");
	const wildcardIndex = segments.findIndex((segment) => /[*?[{]/.test(segment));
	if (wildcardIndex === -1) return { pattern, uri };
	const baseSegments = segments.slice(0, wildcardIndex);
	const patternSegments = segments.slice(wildcardIndex);
	return { uri: `viking://${baseSegments.join("/")}`, pattern: patternSegments.join("/") };
}

async function queryGlobWithFallback(
	client: OpenVikingClient,
	pattern: string,
	uri: string | undefined,
	limit: number,
	signal?: AbortSignal,
): Promise<string[]> {
	const primary = await client.glob({ pattern, uri, limit }, signal);
	if (primary.length > 0) return primary;
	if (pattern.startsWith("**/")) {
		const fallbackPattern = pattern.slice(3);
		if (fallbackPattern && fallbackPattern !== pattern) return client.glob({ pattern: fallbackPattern, uri, limit }, signal);
	}
	return primary;
}

function formatSearchResults(results: Array<{ uri: string; score: number; title?: string; abstract?: string }>): string {
	if (!results || results.length === 0) return "No results found.";
	return results
		.map((result, index) => {
			const title = result.title ?? result.uri;
			const summary = result.abstract ? `\n    ${truncate(result.abstract, 200)}` : "";
			return `[${index + 1}] ${title} (score: ${result.score.toFixed(3)})\n    URI: ${result.uri}${summary}`;
		})
		.join("\n\n");
}

function formatFsEntries(entries: OVFsEntry[]): string {
	if (!entries || entries.length === 0) return "Directory is empty.";
	return entries
		.map((entry) => {
			const type = entry.isDir ? "DIR " : "FILE";
			const size = entry.isDir ? "-" : `${entry.size}B`;
			return `${type}  ${size.padStart(8)}  ${entry.name}  (${entry.uri})`;
		})
		.join("\n");
}

function formatGrepMatches(matches: Array<{ uri: string; line?: number; content?: string }>): string {
	if (!matches || matches.length === 0) return "No matches found.";
	return matches
		.map((match, index) => {
			const line = typeof match.line === "number" ? `:${match.line}` : "";
			const content = match.content ? `\n    ${truncate(match.content, 200)}` : "";
			return `[${index + 1}] ${match.uri}${line}${content}`;
		})
		.join("\n\n");
}

function formatGlobMatches(matches: string[]): string {
	if (!matches || matches.length === 0) return "No matches found.";
	return matches.map((match, index) => `[${index + 1}] ${match}`).join("\n");
}

function formatMemAddResult(
	title: string,
	lane: "memory" | "resource",
	uri: string,
	result: { written_bytes?: number; semantic_status?: string; vector_status?: string },
) {
	const lines = [`Stored ${lane}: ${title}`, `URI: ${uri}`];
	if (typeof result.written_bytes === "number") lines.push(`Bytes: ${result.written_bytes}`);
	if (result.semantic_status) lines.push(`Semantic: ${result.semantic_status}`);
	if (result.vector_status) lines.push(`Vector: ${result.vector_status}`);
	return lines.join("\n");
}

function resolveManualWriteTarget(
	title: string,
	lane: "memory" | "resource",
	targetUri?: string,
): { parentUri: string; fileUri: string; fileName: string } {
	if (targetUri) {
		const trimmed = targetUri.replace(/\/+$/, "");
		const idx = trimmed.lastIndexOf("/");
		if (idx <= "viking://".length) throw new Error(`Invalid target_uri: ${targetUri}`);
		return { parentUri: trimmed.slice(0, idx), fileUri: trimmed, fileName: trimmed.slice(idx + 1) };
	}
	const slug = sanitizeMemoryName(title);
	if (lane === "resource") {
		return { parentUri: "viking://resources/manual", fileUri: `viking://resources/manual/${slug}.md`, fileName: `${slug}.md` };
	}
	return {
		parentUri: `viking://user/default/memories/manual/${slug}`,
		fileUri: `viking://user/default/memories/manual/${slug}/${slug}.md`,
		fileName: `${slug}.md`,
	};
}

function sanitizeMemoryName(input: string): string {
	const cleaned = input.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
	if (!cleaned) throw new Error("Title becomes empty after sanitization.");
	return cleaned;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}
