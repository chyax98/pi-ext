import { describe, expect, it } from "vitest";
import { registerNuTool } from "../src/nu.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function textOf(component: any): string { return component?.text ?? component?.render?.(80)?.join("\n") ?? ""; }

describe("nu TUI renderer", () => {
  it("renders compact collapsed and empty command summaries", () => {
    let registered: any;
    registerNuTool({ registerTool(def: any) { registered = def; } } as any);
    expect(textOf(registered.renderCall({ command: "ls | first 1" }, theme))).toBe("nu ls | first 1");
    expect(textOf(registered.renderResult({ content: [{ type: "text", text: "row" }] }, {}, theme, {}))).toBe("↳ 1 line returned • Ctrl+O to expand");
    expect(textOf(registered.renderResult({ content: [{ type: "text", text: "" }] }, {}, theme, {}))).toBe("↳ command completed (no output)");
  });


  it("keeps command failure summaries visible and expands details", () => {
    let registered: any;
    registerNuTool({ registerTool(def: any) { registered = def; } } as any);
    const failed = { isError: true, content: [{ type: "text", text: "command failed\nstack detail" }] };
    expect(textOf(registered.renderResult(failed, {}, theme, {}))).toBe("↳ command failed");
    expect(textOf(registered.renderResult(failed, { expanded: true }, theme, { expanded: true }))).toContain("stack detail");
  });
});
