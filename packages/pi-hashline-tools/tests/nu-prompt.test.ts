import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("prompts/nu.md", () => {
  it("exists and contains structured exploration description", () => {
    const content = readFileSync(resolve(__dirname, "../prompts/nu.md"), "utf-8");
    expect(content).toContain("Nushell");
    expect(content).toContain("structured");
    expect(content).toContain("bash");
  });

  it("mentions structured exploration and data wrangling use cases", () => {
    const content = readFileSync(resolve(__dirname, "../prompts/nu.md"), "utf-8");
    expect(content).toContain("data wrangling");
  });

  it("keeps a short first paragraph and documents failure hints", () => {
    const content = readFileSync(resolve(__dirname, "../prompts/nu.md"), "utf-8");
    // First paragraph stays short so NU_DESC (derived from it) does not grow.
    const firstParagraph = content.split(/\n\s*\n/, 1)[0]!.trim();
    expect(firstParagraph.length).toBeGreaterThan(0);
    expect(firstParagraph.length).toBeLessThanOrEqual(400);
    expect(content).toContain("[nu-hint]");
    expect(content).toContain("Nushell syntax is not POSIX shell syntax");
  });

  it("documents bash routing, timeout, truncation, and hint markers", () => {
    const content = readFileSync(resolve(__dirname, "../prompts/nu.md"), "utf-8");

    expect(content).toContain("tests, builds, git, package managers, and project commands");
    expect(content).toContain("default 30");
    expect(content).toContain("2000 lines or 50 KB");
    expect(content).toContain("[nu-hint]");
  });
});
