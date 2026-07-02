import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PORT_FILE_NAME, writePortFile } from "./report-port";

describe("writePortFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "meshbot-port-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("把端口与 pid 写成 JSON 到 agent.port", () => {
    writePortFile(dir, 7727, 4242);
    const raw = readFileSync(path.join(dir, PORT_FILE_NAME), "utf8");
    expect(JSON.parse(raw)).toEqual({ port: 7727, pid: 4242 });
  });

  it("重复写入覆盖旧内容", () => {
    writePortFile(dir, 7727, 1);
    writePortFile(dir, 7800, 2);
    const raw = readFileSync(path.join(dir, PORT_FILE_NAME), "utf8");
    expect(JSON.parse(raw)).toEqual({ port: 7800, pid: 2 });
  });
});
