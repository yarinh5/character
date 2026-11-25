import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routesDirectory = join(process.cwd(), "src", "routes");

describe("route form-label associations", () => {
  it("does not render a Label without an explicit control association", () => {
    const violations = readdirSync(routesDirectory)
      .filter((name) => name.endsWith(".tsx"))
      .flatMap((name) => {
        const source = readFileSync(join(routesDirectory, name), "utf8");
        return Array.from(source.matchAll(/<Label\b([^>]*)>/gs))
          .filter((match) => !/\bhtmlFor\s*=/.test(match[1]))
          .map((match) => {
            const line = source.slice(0, match.index).split("\n").length;
            return `${name}:${line}`;
          });
      });

    expect(violations).toEqual([]);
  });
});
