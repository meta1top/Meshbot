import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setConfigDirForTesting,
  getConfigValue,
  readConfig,
  setConfigValue,
  writeConfig,
} from "../../src/utils/config.js";

describe("config", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-cli-test-"));
    __setConfigDirForTesting(testDir);
  });

  afterEach(() => {
    __setConfigDirForTesting(null);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns default config when file does not exist", () => {
    const config = readConfig();
    expect(config.port).toBeUndefined();
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
