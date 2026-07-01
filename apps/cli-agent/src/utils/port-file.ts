import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

export interface PortInfo {
  port: number;
  pid: number;
}

function portFilePath(dataDir: string): string {
  return path.join(dataDir, "agent.port");
}

/** 读 `<dataDir>/agent.port`；不存在或损坏返回 null。 */
export function readPortInfo(dataDir: string): PortInfo | null {
  const f = portFilePath(dataDir);
  if (!existsSync(f)) return null;
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8")) as Partial<PortInfo>;
    if (typeof parsed.port === "number") {
      return {
        port: parsed.port,
        pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      };
    }
  } catch {
    // malformed → null
  }
  return null;
}

/** 删除端口文件（启动前清理陈旧记录，避免读到上轮端口）。 */
export function clearPortFile(dataDir: string): void {
  const f = portFilePath(dataDir);
  if (existsSync(f)) {
    try {
      unlinkSync(f);
    } catch {
      // ignore
    }
  }
}

/** 轮询等待 server-agent 写出 agent.port；超时抛错。 */
export async function waitForPortFile(
  dataDir: string,
  timeoutMs: number,
): Promise<PortInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readPortInfo(dataDir);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待 agent.port 超时（${timeoutMs / 1000}s）`);
}
