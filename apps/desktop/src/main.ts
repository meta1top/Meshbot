import * as path from "node:path";
import * as http from "node:http";
import { app, BrowserWindow, dialog } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import {
  ensureDirs,
  openDatabase,
  getSetupStatus,
  getDatabase,
  getAnybotDir,
  getLogDir,
} from "./database";
import { registerIpcHandlers } from "./ipc-handlers";

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;

function createWindow(setupMode: boolean) {
  const route = setupMode ? "/setup" : "/";
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadURL(`http://localhost:3001${route}`);

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

      const req = http.get("http://localhost:3100", (res: http.IncomingMessage) => {
        res.resume();
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

function startServerAgent(): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverAgentPath = path.join(
      __dirname,
      "..",
      "..",
      "server-agent",
      "dist",
      "main.js",
    );

    serverProcess = fork(serverAgentPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        ANYBOT_DIR: getAnybotDir(),
      },
    });

    let stderr = "";
    serverProcess.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      reject(new Error(`server-agent start timeout (30s)\n${stderr}`));
    }, 30000);

    serverProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    serverProcess.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== null) {
        reject(new Error(`server-agent exited with code ${code}\n${stderr}`));
      }
    });

    pollForReady(30000).then(() => {
      clearTimeout(timeout);
      resolve();
    }).catch((err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

app.whenReady().then(async () => {
  try {
    ensureDirs();
    const database = openDatabase();
    const { needsSetup } = getSetupStatus(database);

    registerIpcHandlers(database, () => mainWindow, startServerAgent);

    if (!needsSetup) {
      try {
        await startServerAgent();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        dialog.showErrorBox(
          "Server Agent 启动失败",
          `无法启动 server-agent：${message}\n\n请检查日志：${getLogDir()}`,
        );
      }
    }

    mainWindow = createWindow(needsSetup);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      "启动失败",
      `无法初始化应用：${message}\n\n请检查 ${getAnybotDir()} 目录权限`,
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      const database = getDatabase();
      const { needsSetup } = getSetupStatus(database);
      mainWindow = createWindow(needsSetup);
    } catch {
      // App was never fully initialized
    }
  }
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
