import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

describe("Clojure mapper file removal", () => {
  it("removes the Clojure mapper source file", () => {
    expect(existsSync(resolve("src/readmap/mappers/clojure.ts"))).toBe(false);
  });
});
