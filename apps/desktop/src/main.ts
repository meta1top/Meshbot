import path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { startAgentRuntime, stopAgentRuntime } from "./agent-runtime";
import { registerIpcHandlers } from "./ipc-handlers";
import { startStaticServer } from "./static-server";

let mainWindow: BrowserWindow | null = null;
let staticServer: { server: import("node:http").Server; port: number } | null =
  null;

function createWindow(agentUrl: string) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#1a1a1a",
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

  win.loadURL(agentUrl);

  return win;
}

async function getAgentUrl(): Promise<string> {
  // UI 热更联调逃生门：自行起 dev:server-agent + dev:web-agent 后，
  // MESHBOT_DESKTOP_DEV_URL=http://localhost:3001 pnpm dev:desktop
  const devUrl = process.env.MESHBOT_DESKTOP_DEV_URL;
  if (devUrl) {
    return devUrl;
  }

  // 默认自包含（dev 与 packaged 同路径）：fork 内置 server-agent 并等就绪，
  // 再起静态 UI server。dev 模式静态资源直接用 workspace 的 web-agent 构建产物。
  await startAgentRuntime();

  const webAgentPath = app.isPackaged
    ? path.join(__dirname, "web-agent")
    : path.resolve(__dirname, "..", "..", "web-agent", "out");
  staticServer = await startStaticServer(webAgentPath);
  return `http://127.0.0.1:${staticServer.port}`;
}

app.whenReady().then(async () => {
  try {
    const agentUrl = await getAgentUrl();
    registerIpcHandlers(() => mainWindow);
    mainWindow = createWindow(agentUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox("启动失败", message);
    stopAgentRuntime();
    app.quit();
  }
});

app.on("window-all-closed", () => {
  staticServer?.server.close();
  staticServer = null;
  if (process.platform !== "darwin") {
    stopAgentRuntime();
    app.quit();
  }
});

app.on("before-quit", () => {
  stopAgentRuntime();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const agentUrl = await getAgentUrl();
    mainWindow = createWindow(agentUrl);
  }
});
