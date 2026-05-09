import { app, BrowserWindow, dialog } from "electron";
import { registerIpcHandlers } from "./ipc-handlers";
import path from "node:path";

const DEV_AGENT_URL = "http://localhost:3001";

let mainWindow: BrowserWindow | null = null;

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
    win.loadFile(path.join(__dirname, "web-agent", "index.html"));
  } else {
    win.loadURL(DEV_AGENT_URL);
  }

  return win;
}

app.whenReady().then(() => {
  try {
    registerIpcHandlers(() => mainWindow);
    mainWindow = createWindow();
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

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
  }
});
