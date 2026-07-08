import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setConfigDirForTesting,
  getConfigValue,
  isValidConfigKey,
  parseConfigValue,
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

describe("isValidConfigKey", () => {
  it("接受受支持的键", () => {
    expect(isValidConfigKey("dataDir")).toBe(true);
    expect(isValidConfigKey("port")).toBe(true);
  });

  it("拒绝未知键与大小写错误", () => {
    expect(isValidConfigKey("nope")).toBe(false);
    expect(isValidConfigKey("datadir")).toBe(false);
  });
});

describe("parseConfigValue", () => {
  it("number 键转数字，非数字抛错", () => {
    expect(parseConfigValue("port", "8080")).toBe(8080);
    expect(() => parseConfigValue("port", "abc")).toThrow();
  });

  it("boolean 键只认 true/false", () => {
    expect(parseConfigValue("autoStart", "true")).toBe(true);
    expect(parseConfigValue("autoStart", "false")).toBe(false);
    expect(() => parseConfigValue("autoStart", "yes")).toThrow();
  });

  it("string 键保持字符串（数字样值不被误转）", () => {
    expect(parseConfigValue("dataDir", "/tmp/x")).toBe("/tmp/x");
    expect(parseConfigValue("dataDir", "123")).toBe("123");
  });
});
