import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPortFile,
  readPortInfo,
  waitForPortFile,
} from "../../src/utils/port-file.js";

describe("port-file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "meshbot-cli-port-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readPortInfo 解析 agent.port", () => {
    writeFileSync(
      path.join(dir, "agent.port"),
      JSON.stringify({ port: 7727, pid: 42 }),
    );
    expect(readPortInfo(dir)).toEqual({ port: 7727, pid: 42 });
  });

  it("readPortInfo 文件不存在返回 null", () => {
    expect(readPortInfo(dir)).toBeNull();
  });

  it("clearPortFile 删除文件后 readPortInfo 返回 null", () => {
    writeFileSync(
      path.join(dir, "agent.port"),
      JSON.stringify({ port: 1, pid: 2 }),
    );
    clearPortFile(dir);
    expect(readPortInfo(dir)).toBeNull();
  });

  it("waitForPortFile 在文件出现后返回端口信息", async () => {
    setTimeout(() => {
      writeFileSync(
        path.join(dir, "agent.port"),
        JSON.stringify({ port: 7800, pid: 7 }),
      );
    }, 150);
    await expect(waitForPortFile(dir, 3000)).resolves.toEqual({
      port: 7800,
      pid: 7,
    });
  });

  it("readPortInfo 损坏 JSON 返回 null", () => {
    writeFileSync(path.join(dir, "agent.port"), "{ invalid json");
    expect(readPortInfo(dir)).toBeNull();
  });

  it("waitForPortFile 超时抛错", async () => {
    await expect(waitForPortFile(dir, 300)).rejects.toThrow("超时");
  });
});
