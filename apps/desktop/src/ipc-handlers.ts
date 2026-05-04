import { type BrowserWindow, ipcMain } from "electron";

export function registerIpcHandlers(
  _getMainWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle("is-electron", () => true);
}
