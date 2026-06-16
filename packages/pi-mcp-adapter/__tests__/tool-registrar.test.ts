import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { transformMcpContent } from "../tool-registrar.ts";

describe("transformMcpContent", () => {
  it("spills oversized text results to a temp file before returning model context", () => {
    const hugeText = `${"x".repeat(60 * 1024)}\nlast line`;

    const [block] = transformMcpContent([{ type: "text", text: hugeText }]);

    expect(block?.type).toBe("text");
    const text = block?.type === "text" ? block.text : "";
    expect(text.length).toBeLessThan(55 * 1024);
    expect(text).toContain("[MCP output truncated:");
    expect(text).toContain("Full output saved to:");

    const outputPath = text.match(/Full output saved to: (.+)/)?.[1]?.trim();
    expect(outputPath).toBeTruthy();
    expect(existsSync(outputPath!)).toBe(true);
    expect(readFileSync(outputPath!, "utf-8")).toBe(hugeText);
  });
});
