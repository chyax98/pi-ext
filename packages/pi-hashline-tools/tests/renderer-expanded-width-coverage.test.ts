import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerBashRendererTool } from "../src/bash-renderer.js";
import { registerEditTool } from "../src/edit.js";
import { registerFindTool } from "../src/find.js";
import { registerGrepTool } from "../src/grep.js";
import { registerLsTool } from "../src/ls.js";
import { registerNuTool } from "../src/nu.js";
import { registerReadTool } from "../src/read.js";
import { registerSgTool } from "../src/sg.js";
import { registerWriteTool } from "../src/write.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function textOf(component: any, width = 80): string { return component?.text ?? component?.render?.(width)?.join("\n") ?? ""; }
function capture(register: (pi: any, options?: any) => any, options: any = {}): any { let registered: any; register({ registerTool(def: any) { registered = def; } }, options); return registered; }
function linesFit(text: string, width: number): boolean { return text.split("\n").every((line) => visibleWidth(line) <= width); }

describe("owned renderer expanded and width coverage", () => {
  it("covers expanded successful output for every owned renderer", async () => {
    const cwd = process.cwd();
    const read = capture(registerReadTool as any, {});
    const grep = capture(registerGrepTool as any, {});
    const find = capture(registerFindTool as any);
    const ls = capture(registerLsTool as any);
    const edit = capture(registerEditTool as any, { wasReadInSession: () => true });
    const write = capture(registerWriteTool as any, {});
    const nu = capture(registerNuTool as any);
    const sg = capture(registerSgTool as any, {});
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok\nsecond" }] }));
    let bash: any;
    registerBashRendererTool({ registerTool(def: any) { bash = def; } } as any, { cwd, createBuiltInBashTool: () => ({ execute, parameters: {} }) });

    const readText = textOf(read.renderResult({ content: [{ type: "text", text: "1:abc|const value = 1;" }], details: { ptcValue: { range: { startLine: 1, endLine: 1, totalLines: 1 }, truncation: null, symbol: null, map: {}, warnings: [] } } }, { expanded: true }, theme, { expanded: true }), 80);
    expect(readText).toContain("1:abc|const value = 1;");

    const grepText = textOf(grep.renderResult({ content: [{ type: "text", text: "src/a.ts:1:abc|needle" }], details: { ptcValue: { totalMatches: 1, records: [{ path: `${cwd}/src/a.ts`, kind: "match" }] } } }, { expanded: true }, theme, { expanded: true, cwd }), 80);
    expect(grepText).toContain("src/a.ts (1)");

    const findText = textOf(find.renderResult({ content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }], details: { ptcValue: { totalEntries: 2 } } }, { expanded: true }, theme, { expanded: true }), 80);
    expect(findText).toContain("src/a.ts");

    const lsText = textOf(ls.renderResult({ content: [{ type: "text", text: "read.ts\nwrite.ts" }], details: { ptcValue: { totalEntries: 2 } } }, { expanded: true }, theme, { expanded: true }), 80);
    expect(lsText).toContain("read.ts");

    const editText = textOf(edit.renderResult({ content: [{ type: "text", text: "1:abc|new" }], details: { diffData: { version: 1, stats: { added: 1, removed: 0, context: 0 }, entries: [{ kind: "add", newLine: 1, text: "new" }] }, ptcValue: { warnings: [], noopEdits: [], semanticSummary: { classification: "semantic" } } } }, { expanded: true }, theme, { expanded: true }), 80);
    expect(editText).toContain("↳ diff +1 -0");

    // Pure create has no diff UI — every line is an add. Use overwritten state to exercise the diff renderer.
    const writeText = textOf(write.renderResult({ content: [{ type: "text", text: "1:abc|new" }], details: { writeState: "overwritten", diffData: { version: 1, stats: { added: 1, removed: 1, context: 0 }, entries: [{ kind: "remove", oldLine: 1, text: "old" }, { kind: "add", newLine: 1, text: "new" }] } } }, { expanded: true }, theme, { expanded: true }), 80);
    expect(writeText).toContain("↳ diff +1 -1");

    if (nu) {
      const nuText = textOf(nu.renderResult({ content: [{ type: "text", text: "row\nsecond" }] }, { expanded: true }, theme, { expanded: true }), 80);
      expect(nuText).toContain("second");
    }

    const sgText = textOf(sg.renderResult({ content: [{ type: "text", text: "src/a.ts\n1:abc|console.log(a)" }], details: { ptcValue: { files: [{ path: `${cwd}/src/a.ts`, lines: [{ line: 1 }] }] } } }, { expanded: true }, theme, { expanded: true, cwd }), 80);
    expect(sgText).toContain("src/a.ts (1)");

    const bashText = textOf(bash.renderResult({ content: [{ type: "text", text: "ok\nsecond" }] }, { expanded: true }, theme, { expanded: true }), 80);
    expect(bashText).toContain("second");
  });

  it("keeps representative call and result output from every owned renderer within supplied width", () => {
    const width = 24;
    const cwd = process.cwd();
    const renderers = {
      read: capture(registerReadTool as any, {}),
      grep: capture(registerGrepTool as any, {}),
      find: capture(registerFindTool as any),
      ls: capture(registerLsTool as any),
      edit: capture(registerEditTool as any, { wasReadInSession: () => true }),
      write: capture(registerWriteTool as any, {}),
      nu: capture(registerNuTool as any),
      sg: capture(registerSgTool as any, {}),
    };
    let bash: any;
    registerBashRendererTool({ registerTool(def: any) { bash = def; } } as any, { cwd, createBuiltInBashTool: () => ({ execute: vi.fn(), parameters: {} }) });

    const samples = [
      textOf(renderers.read.renderCall({ path: "src/very/long/path/read-target.ts", offset: 100, limit: 25 }, theme, { width }), width),
      textOf(renderers.read.renderResult({ content: [{ type: "text", text: "1:abc|const veryLongIdentifierName = 'value';" }], details: { ptcValue: { range: { startLine: 1, endLine: 1, totalLines: 1 }, truncation: null, symbol: null, map: {}, warnings: [] } } }, { expanded: true, width }, theme, { expanded: true, width }), width),
      textOf(renderers.grep.renderCall({ pattern: "veryLongSearchPattern", path: "src/very/long/path" }, theme, { width }), width),
      textOf(renderers.grep.renderResult({ content: [{ type: "text", text: "src/a.ts:1:abc|needle" }], details: { ptcValue: { totalMatches: 1, records: [{ path: `${cwd}/src/a.ts`, kind: "match" }] } } }, { expanded: true, width }, theme, { expanded: true, width, cwd }), width),
      textOf(renderers.find.renderCall({ pattern: "*.typescript", path: "src/very/long/path" }, theme, { width }), width),
      textOf(renderers.find.renderResult({ content: [{ type: "text", text: "src/very-long-file-name.ts" }], details: { ptcValue: { totalEntries: 1 } } }, { expanded: true, width }, theme, { expanded: true, width }), width),
      textOf(renderers.ls.renderCall({ path: "src/very/long/path" }, theme, { width }), width),
      textOf(renderers.ls.renderResult({ content: [{ type: "text", text: "very-long-file-name.ts" }], details: { ptcValue: { totalEntries: 1 } } }, { expanded: true, width }, theme, { expanded: true, width }), width),
      textOf(renderers.edit.renderCall({ path: "src/very/long/path/edit-target.ts", edits: [{ replace: { old_text: "old", new_text: "new" } }] }, theme, { width, argsComplete: true }), width),
      textOf(renderers.edit.renderResult({ content: [{ type: "text", text: "1:abc|new" }], details: { diffData: { version: 1, stats: { added: 1, removed: 0, context: 0 }, entries: [{ kind: "add", newLine: 1, text: "new value with a long tail" }] }, ptcValue: { warnings: [], noopEdits: [] } } }, { expanded: true, width }, theme, { expanded: true, width }), width),
      textOf(renderers.write.renderCall({ path: "src/very/long/path/write-target.ts", content: "one\ntwo" }, theme, { width }), width),
      textOf(renderers.write.renderResult({ content: [{ type: "text", text: "1:abc|new" }], details: { writeState: "overwritten", diffData: { version: 1, stats: { added: 1, removed: 1, context: 0 }, entries: [{ kind: "remove", oldLine: 1, text: "old value with a long tail" }, { kind: "add", newLine: 1, text: "new value with a long tail" }] } } }, { expanded: true, width }, theme, { expanded: true, width }), width),
      textOf(renderers.sg.renderCall({ pattern: "console.log($VERY_LONG_ARGUMENT)", path: "src/very/long/path", lang: "typescript" }, theme, { width }), width),
      textOf(renderers.sg.renderResult({ content: [{ type: "text", text: "src/a.ts\n1:abc|console.log(a)" }], details: { ptcValue: { files: [{ path: `${cwd}/src/a.ts`, lines: [{ line: 1 }] }] } } }, { expanded: true, width }, theme, { expanded: true, width, cwd }), width),
      textOf(bash.renderCall({ command: "npm run very-long-script-name -- --flag" }, theme, { width }), width),
      textOf(bash.renderResult({ content: [{ type: "text", text: "very long bash output row" }] }, { expanded: true, width }, theme, { expanded: true, width }), width),
    ];
    if (renderers.nu) {
      samples.push(
        textOf(renderers.nu.renderCall({ command: "ls | where name =~ very-long-pattern" }, theme, { width }), width),
        textOf(renderers.nu.renderResult({ content: [{ type: "text", text: "very long output row" }] }, { expanded: true, width }, theme, { expanded: true, width }), width),
      );
    }

    for (const sample of samples) expect(linesFit(sample, width), sample).toBe(true);
  });
});
