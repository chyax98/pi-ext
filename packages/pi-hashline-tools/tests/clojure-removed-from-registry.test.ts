import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Clojure registry removal", () => {
  it("removes Clojure from mapper registries and version tests", () => {
    const mapper = readFileSync(resolve("src/readmap/mapper.ts"), "utf8");
    const versions = readFileSync(resolve("tests/mapper-versions.test.ts"), "utf8");
    const syntax = readFileSync(resolve("src/edit-syntax-validate.ts"), "utf8");
    expect(mapper).not.toMatch(/clojure/i);
    expect(versions).not.toMatch(/clojure/i);
    expect(syntax).not.toMatch(/clojure/i);
  });
});
