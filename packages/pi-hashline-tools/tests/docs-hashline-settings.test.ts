import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Hashline settings documentation", () => {
  it("documents exploratory verification steps for JSON settings, env fallback, and env overrides", async () => {
    const doc = await readFile("docs/exploratory-functional-testing.md", "utf8");

    expect(doc).toContain("JSON settings verification procedure:");
    expect(doc).toContain("confirm it overrides the global JSON value");
    expect(doc).toContain("confirm the existing env-only grep, map-cache, and Bash context-guard behavior still applies");
    expect(doc).toContain("confirm the env value wins");
  });
});
