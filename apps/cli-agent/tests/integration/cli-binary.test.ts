import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

describe("CLI binary", () => {
  it("prints help with all commands", () => {
    const cliPath = path.resolve(__dirname, "..", "..", "dist", "index.js");
    const output = execSync(`node ${cliPath} --help`, { encoding: "utf8" });
    expect(output).toContain("anybot");
    expect(output).toContain("start");
    expect(output).toContain("stop");
    expect(output).toContain("status");
    expect(output).toContain("service");
    expect(output).toContain("config");
  });
});
