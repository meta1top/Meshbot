import { type ChildProcess, fork } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PROD_CLOUD_URL = "https://api-bot.meta1.top";
const READINESS_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const HEALTH_PATH = "/api/health";

let child: ChildProcess | null = null;
let currentPort: number | null = null;
/**
 * 「这个子进程是被我们主动停掉的」标记，**挂在子进程实例上，不能用模块级单标志**。
 *
 * 真机 bug：打包版启动中（窗口还没出现）点 dock 图标 → `app.on("activate")` 里
 * `BrowserWindow.getAllWindows().length === 0` 成立 → 再次调 `startAgentRuntime()`。
 * 此时 `child` 已存在但 `currentPort` 仍是 null，幂等判断落空 → 走到
 * `if (child) stopAgentRuntime()`，把**正在启动**的子进程 SIGTERM 掉。
 *
 * 而模块级单标志会让后果扩大一圈：`stopAgentRuntime` 置 true → 第二次 fork 立刻
 * 重置为 false → 旧 child 的 `exit` 事件**这时才异步到达**，读到的已是 false →
 * 报「agent process exited unexpectedly (code=null, signal=SIGTERM)」，并且把
 * `child`/`currentPort` 置 null，**连带清掉新进程的记账**（新进程成孤儿）。
 *
 * 用 WeakSet 按实例记，各管各的，旧进程的迟到 exit 不会误伤新进程。
 */
const intentionallyStopped = new WeakSet<ChildProcess>();
/**
 * 正在进行中的启动。并发调用（whenReady 与 activate 抢跑）必须**复用同一个
 * Promise**，而不是杀掉重启——重启才是上面那个 bug 的起点。
 */
let startPromise: Promise<{ port: number }> | null = null;

/**
 * 启动内置 server-agent 子进程（仅 packaged 模式调用；dev 由开发者自行起服务）。
 * - 复用 Electron 自带 Node 运行时（fork 默认 ELECTRON_RUN_AS_NODE）
 * - 不锁 MESHBOT_PORT → server-agent 自动偏好 7727、占用则探测
 * - 注入 MESHBOT_WEB_AGENT_DIR（打包好的前端），server-agent 同源伺服 UI
 * - 注入 MESHBOT_CLOUD_URL 默认生产云端（显式设置则不覆盖）
 * - 监听 IPC `meshbot:listening` 拿实际端口，再过一次 health 确认 HTTP 就绪
 * - 子进程侧在 IPC 断开时自退（见 server-agent main.ts），壳崩溃不留孤儿
 */
export function startAgentRuntime(): Promise<{ port: number }> {
  // 幂等复用：macOS 关窗不退出、点 dock 会经 app.on("activate") 再次调用；
  // 已就绪则直接返回既有端口，绝不重启或抛错（否则窗口无法重建）。
  if (child && currentPort != null)
    return Promise.resolve({ port: currentPort });
  // **启动中再次被调用（whenReady 与 activate 抢跑）→ 复用同一个 Promise。**
  // 这里以前是 `if (child) stopAgentRuntime()`——把正在启动的子进程杀掉重来，
  // 正是真机上「启动中点 dock 图标 → 启动失败 SIGTERM」的根因。
  if (startPromise) return startPromise;
  startPromise = doStart().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function doStart(): Promise<{ port: number }> {
  // 残留 child 但既没就绪也没有在途启动（上次启动中途失败）→ 先清理再重启。
  if (child) stopAgentRuntime();

  const entry = require.resolve("@meshbot/server-agent");
  const meshbotHome = path.join(os.homedir(), ".meshbot");
  const webAgentDir = path.join(__dirname, "web-agent");

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

  const spawned = child;
  const exitPromise = new Promise<never>((_, reject) => {
    spawned?.once("exit", (code, signal) => {
      // 只在「退出的正是当前这个」时才清记账——旧进程的迟到 exit 不能把新进程
      // 的 child/currentPort 抹掉（否则新进程变孤儿、壳以为没在跑）。
      if (child === spawned) {
        child = null;
        currentPort = null;
      }
      if (spawned && intentionallyStopped.has(spawned)) return;
      reject(
        new Error(
          `agent process exited unexpectedly (code=${code}, signal=${signal})`,
        ),
      );
    });
  });

  const portPromise = new Promise<number>((resolve, reject) => {
    const proc = child;
    let timer: ReturnType<typeof setTimeout>;
    const handler = (msg: unknown) => {
      if (
        msg &&
        typeof msg === "object" &&
        (msg as { type?: string }).type === "meshbot:listening"
      ) {
        clearTimeout(timer);
        proc?.off("message", handler);
        resolve((msg as { port: number }).port);
      }
    };
    timer = setTimeout(() => {
      proc?.off("message", handler);
      reject(new Error("agent 未在超时内上报监听端口"));
    }, READINESS_TIMEOUT_MS);
    proc?.on("message", handler);
  });

  try {
    const port = await Promise.race([portPromise, exitPromise]);
    await Promise.race([waitForReady(port, READINESS_TIMEOUT_MS), exitPromise]);
    currentPort = port;
    return { port };
  } catch (err) {
    // 启动失败：清理残留子进程并重置状态，允许下次重试（不泄漏孤儿进程）。
    stopAgentRuntime();
    throw err;
  }
}

export function stopAgentRuntime(): void {
  currentPort = null;
  if (!child) return;
  intentionallyStopped.add(child);
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
