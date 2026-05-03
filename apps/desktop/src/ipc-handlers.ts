import { type BrowserWindow, ipcMain } from "electron";
import { getProvidersList, getSetupStatus, saveModelConfig } from "./database";

export function registerIpcHandlers(
  getMainWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle("get-providers", () => {
    return getProvidersList();
  });

  ipcMain.handle("get-setup-status", () => {
    return getSetupStatus();
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
      return saveModelConfig(data);
    },
  );

  ipcMain.handle("complete-setup", async () => {
    const win = getMainWindow();
    if (win) {
      win.webContents.send("setup-complete");
    }
    return { success: true };
  });
}
