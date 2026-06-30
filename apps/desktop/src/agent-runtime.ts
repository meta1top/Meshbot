import { type ChildProcess, fork } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PROD_CLOUD_URL = "https://api.meshbot.app";
const READINESS_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const HEALTH_PATH = "/api/health";

let child: ChildProcess | null = null;
let intentionalStop = false;

/**
 * 启动内置 server-agent 子进程（仅 packaged 模式调用；dev 由开发者自行起服务）。
 * - 复用 Electron 自带 Node 运行时（fork 默认 ELECTRON_RUN_AS_NODE）
 * - 不锁 MESHBOT_PORT → server-agent 自动偏好 7727、占用则探测
 * - 注入 MESHBOT_WEB_AGENT_DIR（打包好的前端），server-agent 同源伺服 UI
 * - 注入 MESHBOT_CLOUD_URL 默认生产云端（显式设置则不覆盖）
 * - 监听 IPC `meshbot:listening` 拿实际端口，再过一次 health 确认 HTTP 就绪
 * - 子进程侧在 IPC 断开时自退（见 server-agent main.ts），壳崩溃不留孤儿
 */
export async function startAgentRuntime(): Promise<{ port: number }> {
  if (child) throw new Error("agent runtime already started");

  const entry = require.resolve("@meshbot/server-agent");
  const meshbotHome = path.join(os.homedir(), ".meshbot");
  const webAgentDir = path.join(__dirname, "web-agent");

  intentionalStop = false;
  child = fork(entry, [], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      MESHBOT_HOME: meshbotHome,
      MESHBOT_WEB_AGENT_DIR: webAgentDir,
      MESHBOT_CLOUD_URL: process.env.MESHBOT_CLOUD_URL ?? PROD_CLOUD_URL,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[agent] ${chunk}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[agent] ${chunk}`);
  });

  const exitPromise = new Promise<never>((_, reject) => {
    child?.once("exit", (code, signal) => {
      child = null;
      if (intentionalStop) return;
      reject(
        new Error(
          `agent process exited unexpectedly (code=${code}, signal=${signal})`,
        ),
      );
    });
  });

  const portPromise = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("agent 未在超时内上报监听端口")),
      READINESS_TIMEOUT_MS,
    );
    child?.on("message", (msg: unknown) => {
      if (
        msg &&
        typeof msg === "object" &&
        (msg as { type?: string }).type === "meshbot:listening"
      ) {
        clearTimeout(timer);
        resolve((msg as { port: number }).port);
      }
    });
  });

  const port = await Promise.race([portPromise, exitPromise]);
  await Promise.race([waitForReady(port, READINESS_TIMEOUT_MS), exitPromise]);
  return { port };
}

export function stopAgentRuntime(): void {
  if (!child) return;
  intentionalStop = true;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  child = null;
}

function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: HEALTH_PATH, timeout: 1500 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve();
          scheduleRetry();
        },
      );
      req.on("error", scheduleRetry);
      req.on("timeout", () => {
        req.destroy();
        scheduleRetry();
      });
    };
    const scheduleRetry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`agent health check timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  });
}
