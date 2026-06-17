import { describe, expect, it } from "vitest";
import { registerFindTool } from "../src/find.js";
import { registerLsTool } from "../src/ls.js";
import { registerNuTool } from "../src/nu.js";
import { registerWriteTool } from "../src/write.js";
import { registerBashRendererTool } from "../src/bash-renderer.js";
import { registerReadTool } from "../src/read.js";
import { registerGrepTool } from "../src/grep.js";

// A Theme-like *class instance* — methods live on the prototype, not as own
// properties. This catches the "{ ...theme }" spread bug that destroys the
// prototype and the "context.width ?? 80" bug that pre-truncates at 80 cols
// when the real ToolRenderContext has no width field.
class FakeTheme {
  fg(_style: string, text: string): string { return text; }
  bold(text: string): string { return text; }
}

function register(fn: (api: any, ...rest: any[]) => void, ...rest: any[]): any {
  let registered: any;
  fn({ registerTool(def: any) { registered = def; } } as any, ...rest);
  return registered;
}

function textOf(component: any, width = 500): string {
  // Use a generous width so any pre-clamping at 80 would be visible as
  // truncation. The component.text field (set by `new Text(text, ...)`)
  // is captured before any width-based wrap.
  return component?.text ?? component?.render?.(width)?.join("\n") ?? "";
}

// 200-char path — well over 80 cols. If anything is pre-clamping to 80, this
// will be truncated and the assertion fails.
const LONG = "a/very/long/path/segment".repeat(8) + "/end.txt";

describe("renderers with no context.width (real ToolRenderContext shape)", () => {
  it("find renderCall shows full pattern without 80-col truncation", () => {
    const tool = register(registerFindTool);
    const out = textOf(tool.renderCall({ pattern: LONG }, new FakeTheme(), {} as any));
    expect(out).toContain(LONG);
    expect(out).toContain("find");
  });

  it("ls renderCall shows full path without 80-col truncation", () => {
    const tool = register(registerLsTool);
    const out = textOf(tool.renderCall({ path: LONG }, new FakeTheme(), {} as any));
    expect(out).toContain(LONG);
    expect(out).toContain("ls");
  });

  it("nu renderCall shows full command without 80-col truncation", () => {
    const tool = register(registerNuTool);
    const cmd = "ls | where name == " + JSON.stringify(LONG) + " | first 1";
    const out = textOf(tool.renderCall({ command: cmd }, new FakeTheme(), {} as any));
    expect(out).toContain(LONG);
    expect(out).toContain("nu");
  });

  it("write renderCall shows full path without 80-col truncation", () => {
    const tool = register(registerWriteTool);
    const out = textOf(tool.renderCall({ path: LONG, content: "x" }, new FakeTheme(), {} as any));
    expect(out).toContain(LONG);
    expect(out).toContain("write");
  });

  it("bash renderCall shows full command without 80-col truncation", () => {
    const tool = register(registerBashRendererTool);
    const cmd = "echo " + LONG;
    const out = textOf(tool.renderCall({ command: cmd }, new FakeTheme(), {} as any));
    expect(out).toContain(LONG);
    expect(out).toContain("bash");
  });

  it("read renderCall shows full path without 80-col truncation", () => {
    const tool = register(registerReadTool);
    const out = textOf(tool.renderCall({ path: LONG }, new FakeTheme(), {} as any));
    expect(out).toContain(LONG);
  });

  it("grep renderCall shows full pattern without 80-col truncation", () => {
    const tool = register(registerGrepTool);
    const out = textOf(tool.renderCall({ pattern: LONG }, new FakeTheme(), {} as any));
    expect(out).toContain(LONG);
  });
});
