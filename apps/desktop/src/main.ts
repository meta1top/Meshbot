import { type ChildProcess, fork } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import * as http from "node:http";
import { homedir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, net, protocol } from "electron";
import { registerIpcHandlers } from "./ipc-handlers";

if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox");
}

const WEB_PORT = 3001;
const SERVER_AGENT_PORT = 3100;
const LOCAL_HOST = "127.0.0.1";
const WEB_DEV_URL = `http://${LOCAL_HOST}:${WEB_PORT}`;
const SERVER_AGENT_HEALTH_URL = `http://${LOCAL_HOST}:${SERVER_AGENT_PORT}/api/setup-status`;
const PROJECT_LOG_DIR = path.join(process.cwd(), ".anybot", "logs");
const PACKAGED_LOG_DIR = path.join(homedir(), ".anybot", "logs");
const LOG_FILE_NAME = "desktop-runtime.log";
const APP_SCHEME = "app";

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function getLogDir(): string {
  return app.isPackaged ? PACKAGED_LOG_DIR : PROJECT_LOG_DIR;
}

function writeLog(scope: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${scope}] ${message}\n`;
  try {
    const logDir = getLogDir();
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, LOG_FILE_NAME), line, "utf8");
  } catch {
    // ignore logging failures to avoid affecting app startup
  }
}

function getWebRoot(): string {
  return path.join(process.resourcesPath, "web-agent");
}

function registerAppProtocol(): void {
  const webRoot = getWebRoot();

  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    let filePath = path.join(webRoot, pathname);

    if (!existsSync(filePath)) {
      const htmlFallback = `${filePath}.html`;
      if (existsSync(htmlFallback)) {
        filePath = htmlFallback;
      }
    }

    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 18 },
    ...(process.platform === "win32" && {
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#666666",
        height: 36,
      },
    }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (app.isPackaged) {
    const appUrl = `${APP_SCHEME}://web/index.html`;
    writeLog("desktop", `Loading static UI via ${appUrl}`);
    win.loadURL(appUrl);
  } else {
    writeLog("desktop", `Loading dev UI from ${WEB_DEV_URL}`);
    win.loadURL(WEB_DEV_URL);
    win.webContents.openDevTools();
  }

  return win;
}

function pollHttpReady(
  url: string,
  serviceName: string,
  timeoutMs: number,
): Promise<void> {
  writeLog(serviceName, `Start health check at ${url}`);
  return new Promise((resolve, reject) => {
    const endTime = Date.now() + timeoutMs;

    const poll = () => {
      if (Date.now() >= endTime) {
        reject(new Error(`${serviceName} start timeout (${timeoutMs / 1000}s)`));
        return;
      }

      const req = http.get(url, (res: http.IncomingMessage) => {
        res.resume();
        writeLog(serviceName, `Health check success with status ${res.statusCode}`);
        resolve();
      });
      req.on("error", () => {
        setTimeout(poll, 500);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(poll, 500);
      });
    };
    setTimeout(poll, 1000);
  });
}

async function forkServerAgent(): Promise<void> {
  const serverAgentPath = path.join(
    process.resourcesPath,
    "server-agent",
    "dist",
    "main.js",
  );
  let restartCount = 0;
  let settled = false;

  return new Promise((resolve, reject) => {
    const doFork = () => {
      if (settled) return;
      writeLog("server-agent", `Forking ${serverAgentPath} (attempt ${restartCount + 1})`);
      serverProcess = fork(serverAgentPath, [], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: process.env,
      });

      let stdout = "";
      let stderr = "";

      serverProcess.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        writeLog("server-agent:stdout", text.trimEnd());
      });

      serverProcess.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        writeLog("server-agent:stderr", text.trimEnd());
      });

      serverProcess.on("error", (err) => {
        if (settled) return;
        writeLog("server-agent", `Fork error: ${err.message}`);
        settled = true;
        reject(new Error(`server-agent fork failed: ${err.message}`));
      });

      serverProcess.on("exit", (code) => {
        writeLog("server-agent", `Exited with code ${String(code)}`);
        if (settled) return;
        if (code !== 0 && code !== null && restartCount < 3) {
          restartCount++;
          stderr = "";
          setTimeout(doFork, 2000);
        } else if (code !== 0 && code !== null) {
          settled = true;
          reject(
            new Error(
              `server-agent exited with code ${code} after ${restartCount + 1} attempts\n${stderr}`,
            ),
          );
        }
      });

      pollHttpReady(SERVER_AGENT_HEALTH_URL, "server-agent", 30000)
        .then(() => {
          if (settled) return;
          settled = true;
          writeLog("server-agent", "Ready");
          resolve();
        })
        .catch((_err) => {
          if (settled) return;
          settled = true;
          if (serverProcess) {
            serverProcess.kill();
            serverProcess = null;
          }
          reject(
            new Error(
              `server-agent start timeout (30s)\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
        });
    };

    doFork();
  });
}

function startServerAgent(): Promise<void> {
  if (app.isPackaged) {
    return forkServerAgent();
  }
  return connectToServerAgent();
}

async function connectToServerAgent(): Promise<void> {
  while (true) {
    try {
      await pollHttpReady(SERVER_AGENT_HEALTH_URL, "server-agent", 10000);
      return;
    } catch {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: "server-agent 未启动",
        message:
          "开发模式下需要手动启动 server-agent。\n\n请在终端运行：pnpm dev:server-agent\n然后点击「重试」。",
        buttons: ["重试", "退出"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 1) {
        app.quit();
        return;
      }
    }
  }
}

async function connectToWebAgent(): Promise<void> {
  while (true) {
    try {
      await pollHttpReady(WEB_DEV_URL, "web-agent", 10000);
      return;
    } catch {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: "web-agent 未启动",
        message:
          "开发模式下需要手动启动 web-agent。\n\n请在终端运行：pnpm dev:web-agent\n然后点击「重试」。",
        buttons: ["重试", "退出"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 1) {
        app.quit();
        return;
      }
    }
  }
}

app.whenReady().then(async () => {
  try {
    writeLog(
      "desktop",
      `App ready. mode=${app.isPackaged ? "packaged" : "dev"} logDir=${getLogDir()}`,
    );

    if (app.isPackaged) {
      registerAppProtocol();
    }

    await startServerAgent();
    if (!app.isPackaged) {
      await connectToWebAgent();
    }

    registerIpcHandlers(() => mainWindow);

    mainWindow = createWindow();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    writeLog("desktop", `Startup failed: ${message}`);
    dialog.showErrorBox(
      "启动失败",
      `无法初始化应用：${message}\n\n请检查 server-agent 运行日志`,
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
  }
});

app.on("before-quit", () => {
  writeLog("desktop", "before-quit triggered");
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});

app.on("will-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});

process.on("uncaughtException", (error) => {
  writeLog("desktop", `uncaughtException: ${error.stack ?? error.message}`);
});

process.on("unhandledRejection", (reason) => {
  writeLog("desktop", `unhandledRejection: ${String(reason)}`);
});
