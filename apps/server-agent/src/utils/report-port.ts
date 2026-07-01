import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 端口文件名（位于 meshbotDir 下）。 */
export const PORT_FILE_NAME = "agent.port";

/**
 * 原子写入 `<meshbotDir>/agent.port`（tmp + rename），内容 `{port,pid}`。
 * 供 CLI 等无 IPC 通道的启动器发现 server-agent 实际监听端口。
 */
export function writePortFile(
  meshbotDir: string,
  port: number,
  pid: number,
): void {
  const target = path.join(meshbotDir, PORT_FILE_NAME);
  const tmp = `${target}.${pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ port, pid }), "utf8");
  renameSync(tmp, target);
}

/**
 * 端口就绪后统一上报：
 * - 写端口文件（所有形态）；
 * - 若被 fork（`process.send` 存在），额外发 IPC 消息给父进程（桌面端用）。
 */
export function reportPort(meshbotDir: string, port: number): void {
  writePortFile(meshbotDir, port, process.pid);
  if (process.send) {
    process.send({ type: "meshbot:listening", port });
  }
}
