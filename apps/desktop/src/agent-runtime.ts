import { type ChildProcess, fork } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const AGENT_PORT = 3100;
const READINESS_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const HEALTH_PATH = "/api/health";

let child: ChildProcess | null = null;
let intentionalStop = false;

/**
 * 启动内置 server-agent 子进程。
 * - 复用 Electron 自带 Node 运行时（fork 默认 ELECTRON_RUN_AS_NODE）
 * - MESHBOT_HOME 显式注入 ~/.meshbot，确保跨平台一致
 * - 等待 /api/health 200 后才 resolve，UI 不会拿到空后端
 */
export async function startAgentRuntime(): Promise<void> {
  if (child) return;

  const entry = require.resolve("@meshbot/server-agent");
  const meshbotHome = path.join(os.homedir(), ".meshbot");

  intentionalStop = false;
  child = fork(entry, [], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      MESHBOT_PORT: String(AGENT_PORT),
      MESHBOT_HOME: meshbotHome,
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

  await Promise.race([
    waitForReady(AGENT_PORT, READINESS_TIMEOUT_MS),
    exitPromise,
  ]);
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
