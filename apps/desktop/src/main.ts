import { app, BrowserWindow, dialog } from "electron";
import { registerIpcHandlers } from "./ipc-handlers";
import { startStaticServer } from "./static-server";
import path from "node:path";

const DEV_AGENT_URL = "http://localhost:3001";

let mainWindow: BrowserWindow | null = null;
let staticServer: { server: import("node:http").Server; port: number } | null = null;

function createWindow(agentUrl: string) {
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

  win.loadURL(agentUrl);

  return win;
}

async function getAgentUrl(): Promise<string> {
  if (!app.isPackaged) {
    return DEV_AGENT_URL;
  }

  const webAgentPath = path.join(__dirname, "web-agent");
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
    app.quit();
  }
});

app.on("window-all-closed", () => {
  staticServer?.server.close();
  staticServer = null;
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const agentUrl = await getAgentUrl();
    mainWindow = createWindow(agentUrl);
  }
});
