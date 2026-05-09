import { app, BrowserWindow, dialog } from "electron";
import { registerIpcHandlers } from "./ipc-handlers";

const DEFAULT_AGENT_URL = "http://localhost:3100";

let mainWindow: BrowserWindow | null = null;

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
      preload: __dirname + "/preload.js",
    },
  });

  win.loadURL(agentUrl);

  return win;
}

async function getAgentUrl(): Promise<string> {
  // For now, use default. In future, could show setup window.
  return DEFAULT_AGENT_URL;
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
