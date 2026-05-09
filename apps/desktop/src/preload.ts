import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: () => ipcRenderer.invoke("is-electron"),
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  getConnectionConfig: () => ipcRenderer.invoke("get-connection-config"),
  setConnectionConfig: (config: { url: string; token: string }) =>
    ipcRenderer.invoke("set-connection-config", config),
});
