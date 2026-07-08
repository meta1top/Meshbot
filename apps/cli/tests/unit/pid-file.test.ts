import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setPidDirForTesting,
  clearPid,
  getRunningPid,
  isProcessRunning,
  readPid,
  writePid,
} from "../../src/utils/pid-file.js";

describe("pid-file", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-pid-test-"));
    __setPidDirForTesting(testDir);
  });

  afterEach(() => {
    __setPidDirForTesting(null);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("writes and reads pid", () => {
    writePid(12345);
    expect(readPid()).toBe(12345);
  });

  it("clears pid file", () => {
    writePid(12345);
    clearPid();
    expect(readPid()).toBeNull();
  });

  it("getRunningPid returns null for stale pid", () => {
    writePid(99999); // non-existent process
    expect(getRunningPid()).toBeNull();
  });

  it("isProcessRunning returns true for current process", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });
});
