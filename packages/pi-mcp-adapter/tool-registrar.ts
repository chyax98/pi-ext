// tool-registrar.ts - MCP content transformation
// NOTE: Tools are NOT registered with Pi - only the unified `mcp` proxy tool is registered.
// This keeps the LLM context small (1 tool instead of 100s).

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { McpContent, ContentBlock } from "./types.ts";

const MAX_TEXT_BYTES = 50 * 1024;
const MAX_TEXT_LINES = 2000;

function truncateTextForContext(text: string, maxBytes = MAX_TEXT_BYTES, maxLines = MAX_TEXT_LINES): {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
  originalBytes?: number;
  originalLines?: number;
} {
  const originalBytes = Buffer.byteLength(text, "utf-8");
  const originalLines = text === "" ? 0 : text.split("\n").length;
  if (originalBytes <= maxBytes && originalLines <= maxLines) {
    return { text, truncated: false };
  }

  const outputDir = join(tmpdir(), "pi-mcp-adapter-results");
  mkdirSync(outputDir, { recursive: true });
  const fullOutputPath = join(outputDir, `mcp-output-${Date.now()}-${randomUUID()}.txt`);
  writeFileSync(fullOutputPath, text, "utf-8");

  const selectedLines = text.split("\n").slice(0, maxLines);
  let preview = selectedLines.join("\n");
  while (Buffer.byteLength(preview, "utf-8") > maxBytes) {
    preview = preview.slice(0, Math.max(0, preview.length - 1024));
  }
  if (preview.length < text.length) preview = `${preview}\n…`;

  const notice = [
    "",
    `[MCP output truncated: ${originalBytes} bytes, ${originalLines} lines]`,
    `Full output saved to: ${fullOutputPath}`,
    "Use read with offset/limit or grep to inspect the full result.",
  ].join("\n");

  return {
    text: `${preview}${notice}`,
    truncated: true,
    fullOutputPath,
    originalBytes,
    originalLines,
  };
}

function textBlock(text: string): ContentBlock {
  return { type: "text" as const, text: truncateTextForContext(text).text };
}

/**
 * Transform MCP content types to Pi content blocks.
 */
export function transformMcpContent(content: McpContent[]): ContentBlock[] {
  return content.map(c => {
    if (c.type === "text") {
      return textBlock(c.text ?? "");
    }
    if (c.type === "image") {
      return {
        type: "image" as const,
        data: c.data ?? "",
        mimeType: c.mimeType ?? "image/png",
      };
    }
    if (c.type === "resource") {
      const resourceUri = c.resource?.uri ?? "(no URI)";
      const resourceContent = c.resource?.text ?? (c.resource ? JSON.stringify(c.resource) : "(no content)");
      return textBlock(`[Resource: ${resourceUri}]\n${resourceContent}`);
    }
    if (c.type === "resource_link") {
      const linkName = c.name ?? c.uri ?? "unknown";
      const linkUri = c.uri ?? "(no URI)";
      return textBlock(`[Resource Link: ${linkName}]\nURI: ${linkUri}`);
    }
    if (c.type === "audio") {
      return textBlock(`[Audio content: ${c.mimeType ?? "audio/*"}]`);
    }
    return textBlock(JSON.stringify(c));
  });
}
