import { describe, it, expect } from "vitest";
import { NU_GUIDELINES } from "../src/nu.js";
import { readFileSync } from "node:fs";

const nuPrompt = readFileSync("prompts/nu.md", "utf8");

describe("NU_GUIDELINES prompt-size budget", () => {
  const serialized = NU_GUIDELINES.join("\n\n");

  it("is at most 8 lines when serialized", () => {
    const lineCount = serialized.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(8);
  });

  it("is at most 500 characters when serialized", () => {
    expect(serialized.length).toBeLessThanOrEqual(500);
  });

  it("keeps detailed nu examples in the markdown prompt", () => {
    expect(nuPrompt).toContain("open package.json | get scripts");
    expect(nuPrompt).toContain("plugin list");
  });
});
