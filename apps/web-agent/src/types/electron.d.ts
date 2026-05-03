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

export interface ElectronAPI {
  getProviders(): Promise<ProviderInfo[]>;
  getSetupStatus(): Promise<SetupStatus>;
  saveModelConfig(data: ModelConfigData): Promise<{ success: boolean }>;
  completeSetup(): Promise<void>;
  onSetupComplete(callback: () => void): void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
