"use client";

import { useEffect } from "react";

export function ElectronInit() {
  useEffect(() => {
    const electronAPI = (window as unknown as {
      electronAPI?: { isElectron: boolean; platform?: string };
    }).electronAPI;
    if (electronAPI?.isElectron) {
      document.body.classList.add("electron-shell");
      if (electronAPI.platform === "darwin") {
        document.body.classList.add("mac-shell");
      }
    }
  }, []);

  return null;
}
