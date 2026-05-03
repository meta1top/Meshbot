import { ipcMain, BrowserWindow } from "electron";
import type Database from "better-sqlite3";
import {
  getSetupStatus,
  getProvidersList,
  saveModelConfig,
} from "./database";

export function registerIpcHandlers(
  database: Database.Database,
  getMainWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle("get-providers", () => {
    return getProvidersList();
  });

  ipcMain.handle("get-setup-status", () => {
    return getSetupStatus(database);
  });

  ipcMain.handle(
    "save-model-config",
    (
      _event,
      data: {
        providerType: string;
        name: string;
        model: string;
        apiKey: string;
        baseUrl?: string;
      },
    ) => {
      return saveModelConfig(database, data);
    },
  );

  ipcMain.handle("complete-setup", () => {
    const win = getMainWindow();
    if (win) {
      win.webContents.send("setup-complete");
    }
    return { success: true };
  });
}
