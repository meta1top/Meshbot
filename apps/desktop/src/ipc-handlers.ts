import { type BrowserWindow, ipcMain } from "electron";

export function registerIpcHandlers(
  getMainWindow: () => BrowserWindow | null,
): void {
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
}
