import { describe, expect, it } from "vitest";
import { startInstance } from "@/start";

describe("Start request security", () => {
  it("installs CSRF protection for server functions", async () => {
    const options = await startInstance.getOptions();
    const csrfSymbol = Symbol.for("tanstack-start:csrf-middleware");

    expect(options.requestMiddleware?.some((middleware) => csrfSymbol in middleware)).toBe(true);
  });
});
