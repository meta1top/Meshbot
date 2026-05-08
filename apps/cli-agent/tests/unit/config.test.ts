import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConfig, writeConfig, setConfigValue, getConfigValue, __setConfigDirForTesting } from "../../src/utils/config.js";

describe("config", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "anybot-cli-test-"));
    __setConfigDirForTesting(testDir);
  });

  afterEach(() => {
    __setConfigDirForTesting(null);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns default config when file does not exist", () => {
    const config = readConfig();
    expect(config.port).toBe(3100);
    expect(config.logLevel).toBe("info");
  });

  it("writes and reads config", () => {
    writeConfig({ port: 9999 });
    const config = readConfig();
    expect(config.port).toBe(9999);
  });

  it("setConfigValue updates single key", () => {
    setConfigValue("logLevel", "debug");
    expect(getConfigValue("logLevel")).toBe("debug");
  });
});
