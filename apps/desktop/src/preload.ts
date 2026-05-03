import { contextBridge, ipcRenderer } from "electron";

export interface ProviderInfo {
  type: string;
  name: string;
  description: string;
  default_base_url: string;
  models: string[];
}

export interface SetupStatus {
  needsSetup: boolean;
}

export interface ModelConfigData {
  providerType: string;
  name: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

contextBridge.exposeInMainWorld("electronAPI", {
  getProviders: (): Promise<ProviderInfo[]> =>
    ipcRenderer.invoke("get-providers"),

  getSetupStatus: (): Promise<SetupStatus> =>
    ipcRenderer.invoke("get-setup-status"),

  saveModelConfig: (
    data: ModelConfigData,
  ): Promise<{ success: boolean }> =>
    ipcRenderer.invoke("save-model-config", data),

  completeSetup: (): Promise<void> =>
    ipcRenderer.invoke("complete-setup"),

  onSetupComplete: (callback: () => void) => {
    ipcRenderer.on("setup-complete", () => callback());
  },
});
