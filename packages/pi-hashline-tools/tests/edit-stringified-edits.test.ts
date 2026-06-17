import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerEditTool } from "../src/edit.js";

async function withFixture(content: string, fn: (filePath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "hashline-stringified-edits-"));
  try {
    const filePath = join(dir, "sample.txt");
    await writeFile(filePath, content, "utf8");
    await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeEditTool(): any {
  let tool: any;
  registerEditTool({ registerTool(def: any) { tool = def; } } as any, { wasReadInSession: () => true });
  return tool;
}

describe("edit stringified edits compatibility", () => {
  it("normalizes JSON-stringified edits arrays before applying the edit", async () => {
    await withFixture("alpha\nbeta\n", async (filePath) => {
      const tool = makeEditTool();

      const result = await tool.execute(
        "edit-call",
        {
          path: filePath,
          edits: JSON.stringify([{ replace: { old_text: "beta", new_text: "gamma" } }]),
        },
        new AbortController().signal,
        undefined,
        { cwd: process.cwd() },
      );

      expect(result.isError).not.toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ngamma\n");
      expect(result.content[0].text).toContain("JSON-stringified edits input was normalized");
    });
  });

  it("reports a structured error when stringified edits are not a JSON array", async () => {
    const tool = makeEditTool();

    const result = await tool.execute(
      "edit-call",
      { path: "unused.txt", edits: "{\"replace\":true}" },
      new AbortController().signal,
      undefined,
      { cwd: process.cwd() },
    );

    expect(result.isError).toBe(true);
    expect(result.details.ptcValue.error.code).toBe("invalid-edit-variant");
    expect(result.content[0].text).toContain("edits JSON string must parse to an array");
  });
});
