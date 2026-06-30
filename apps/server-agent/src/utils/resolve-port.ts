import net from "node:net";

/** server-agent 偏好监听端口；dev 与发布形态统一用它。 */
export const PREFERRED_PORT = 7727;

/** 探测单个端口在指定 host 上是否空闲（短暂 bind 后立即释放）。 */
function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** OS 分配一个空闲端口（全部偏好区间被占满时的兜底）。 */
function osAssignedPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : null;
      if (!port) {
        srv.close(() =>
          reject(new Error("osAssignedPort: 无法获取分配的端口")),
        );
        return;
      }
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 从 preferred 起向上扫描首个空闲端口，最多试 maxTries 个；
 * 全被占用则退回 OS 分配的随机空闲端口。
 */
export async function findAvailablePort(
  preferred: number,
  host: string,
  maxTries = 100,
): Promise<number> {
  for (let p = preferred; p < preferred + maxTries && p <= 65535; p++) {
    if (await isPortFree(p, host)) return p;
  }
  return osAssignedPort(host);
}

/**
 * 解析 server-agent 实际监听端口。
 * - `MESHBOT_PORT` 显式设置：严格返回该端口（非法值抛错；占用与否交给 app.listen 决定）。
 * - 未设置：偏好 PREFERRED_PORT，被占则向上探测空闲端口。
 */
export async function resolvePort(host: string): Promise<number> {
  const explicit = process.env.MESHBOT_PORT;
  if (explicit !== undefined && explicit !== "") {
    const p = Number(explicit);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(`MESHBOT_PORT 非法（需 1-65535 整数）：${explicit}`);
    }
    return p;
  }
  return findAvailablePort(PREFERRED_PORT, host);
}
