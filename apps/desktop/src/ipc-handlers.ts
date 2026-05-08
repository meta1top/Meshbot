import { app, type BrowserWindow, ipcMain } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

interface ConnectionConfig {
  url: string;
  token: string;
}

function getConfigPath(): string {
  const userData = app.getPath("userData");
  return path.join(userData, "connection.json");
}

function readConnectionConfig(): ConnectionConfig | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw) as ConnectionConfig;
  } catch {
    return null;
  }
}

function writeConnectionConfig(config: ConnectionConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("is-electron", () => true);

  ipcMain.handle("window-minimize", () => {
    getMainWindow()?.minimize();
  });

  ipcMain.handle("window-maximize", () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.handle("window-close", () => {
    getMainWindow()?.close();
  });

  ipcMain.handle("get-connection-config", () => {
    return readConnectionConfig();
  });

  ipcMain.handle("set-connection-config", (_event, config: ConnectionConfig) => {
    writeConnectionConfig(config);
    return true;
  });
}
