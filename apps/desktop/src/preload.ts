import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getServerPort: () => ipcRenderer.invoke("get-server-port"),
  onServerReady: (callback: () => void) =>
    ipcRenderer.on("server-ready", () => callback()),
});
