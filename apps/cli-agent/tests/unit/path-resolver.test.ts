import { describe, expect, it } from "vitest";
import { resolveServerAgentPath } from "../../src/utils/path-resolver.js";

describe("path-resolver", () => {
  it("resolves via npm when no config or adjacent path", () => {
    const resolved = resolveServerAgentPath();
    expect(resolved).toContain("server-agent");
  });
});
