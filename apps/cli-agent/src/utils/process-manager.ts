import { spawn } from "node:child_process";
import { getServerAgentMainPath, resolveServerAgentPath } from "./path-resolver.js";
import { getRunningPid, writePid, clearPid, isProcessRunning } from "./pid-file.js";
import { readConfig } from "./config.js";
import { log } from "./logger.js";

export interface StartOptions {
  port?: number;
  dataDir?: string;
  daemon?: boolean;
}

async function pollHttpReady(url: string, timeoutMs: number): Promise<void> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const endTime = Date.now() + timeoutMs;

    const poll = () => {
      if (Date.now() >= endTime) {
        reject(new Error(`Health check timeout (${timeoutMs / 1000}s)`));
        return;
      }
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
        } else {
          setTimeout(poll, 500);
        }
      });
      req.on("error", () => setTimeout(poll, 500));
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(poll, 500);
      });
    };
    setTimeout(poll, 1000);
  });
}

export async function startAgent(options: StartOptions = {}): Promise<void> {
  const runningPid = getRunningPid();
  if (runningPid !== null) {
    const config = readConfig();
    console.log(`Agent already running on port ${config.port} (PID: ${runningPid})`);
    return;
  }

  const config = readConfig();
  const port = options.port ?? config.port;
  const dataDir = options.dataDir ?? config.dataDir;
  const serverAgentRoot = resolveServerAgentPath();
  const serverAgentMain = getServerAgentMainPath();

  log("cli", `Starting server-agent: ${serverAgentMain} (port=${port}, dataDir=${dataDir})`);

  const child = spawn("node", [serverAgentMain], {
    cwd: serverAgentRoot,
    stdio: options.daemon ? "ignore" : "inherit",
    env: {
      ...process.env,
      ANYBOT_PORT: String(port),
      ANYBOT_DATA_DIR: dataDir,
    },
    detached: options.daemon ?? false,
  });

  writePid(child.pid!);

  if (options.daemon) {
    child.unref();
  }

  const healthUrl = `http://127.0.0.1:${port}/api/setup-status`;
  try {
    await pollHttpReady(healthUrl, 30000);
    console.log(`Agent started on http://0.0.0.0:${port}`);
  } catch (err) {
    clearPid();
    if (child.kill) child.kill();
    throw new Error(`Agent failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function stopAgent(): void {
  const pid = getRunningPid();
  if (pid === null) {
    console.log("Agent is not running");
    return;
  }

  log("cli", `Stopping agent (PID: ${pid})`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.error(`Failed to send SIGTERM: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Wait up to 5s for graceful shutdown
  let waited = 0;
  const interval = setInterval(() => {
    waited += 200;
    if (!isProcessRunning(pid)) {
      clearInterval(interval);
      clearPid();
      console.log("Agent stopped");
      return;
    }
    if (waited >= 5000) {
      clearInterval(interval);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
      clearPid();
      console.log("Agent stopped (forced)");
    }
  }, 200);
}

export async function getAgentStatus(): Promise<void> {
  const pid = getRunningPid();
  if (pid === null) {
    console.log("Agent is not running");
    return;
  }

  const config = readConfig();
  const healthUrl = `http://127.0.0.1:${config.port}/api/setup-status`;

  try {
    const res = await fetch(healthUrl);
    const data = (await res.json()) as { initialized?: boolean };
    console.log(`Status: running`);
    console.log(`PID: ${pid}`);
    console.log(`Port: ${config.port}`);
    console.log(`Data dir: ${config.dataDir}`);
    console.log(`Health: OK`);
    console.log(`Setup: ${data.initialized ? "initialized" : "needs setup"}`);
  } catch {
    console.log(`Status: running (PID: ${pid})`);
    console.log(`Health: unreachable`);
  }
}
