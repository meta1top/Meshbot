import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import * as http from "node:http";
import { homedir } from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { registerIpcHandlers } from "./ipc-handlers";

const ANYBOT_DIR = path.join(homedir(), ".anybot");

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;

function ensureDirs(): void {
  mkdirSync(ANYBOT_DIR, { recursive: true });
  mkdirSync(path.join(ANYBOT_DIR, "logs"), { recursive: true });
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

  win.loadURL("http://localhost:3001");

  if (!app.isPackaged) {
    win.webContents.openDevTools();
  }

  return win;
}

function pollForReady(timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const endTime = Date.now() + timeoutMs;

    const poll = () => {
      if (Date.now() >= endTime) {
        reject(new Error(`server-agent start timeout (${timeoutMs / 1000}s)`));
        return;
      }

      const req = http.get(
        "http://localhost:3100",
        (res: http.IncomingMessage) => {
          res.resume();
          resolve();
        },
      );
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
    "main.js",
  );
  let restartCount = 0;

  return new Promise((resolve, reject) => {
    const doFork = () => {
      serverProcess = fork(serverAgentPath, [], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: {
          ...process.env,
          ANYBOT_DIR: ANYBOT_DIR,
        },
      });

      let stderr = "";

      serverProcess.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      serverProcess.on("error", (err) => {
        reject(new Error(`server-agent fork failed: ${err.message}`));
      });

      serverProcess.on("exit", (code) => {
        if (code !== 0 && code !== null && restartCount < 3) {
          restartCount++;
          stderr = "";
          setTimeout(doFork, 2000);
        } else if (code !== 0 && code !== null) {
          reject(
            new Error(
              `server-agent exited with code ${code} after ${restartCount + 1} attempts\n${stderr}`,
            ),
          );
        }
      });

      pollForReady(30000)
        .then(resolve)
        .catch((_err) => {
          if (serverProcess) {
            serverProcess.kill();
            serverProcess = null;
          }
          reject(new Error(`server-agent start timeout (30s)\n${stderr}`));
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
      await pollForReady(10000);
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

app.whenReady().then(async () => {
  try {
    ensureDirs();

    await startServerAgent();

    registerIpcHandlers(() => mainWindow);

    mainWindow = createWindow();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      "启动失败",
      `无法初始化应用：${message}\n\n请检查 ${ANYBOT_DIR} 目录权限`,
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
  if (serverProcess) {
    serverProcess.send("shutdown");
    setTimeout(() => {
      if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
      }
    }, 3000);
  }
});
