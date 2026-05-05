"use client";

import { Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

interface ElectronAPI {
  isElectron: boolean;
  platform?: string;
  windowMinimize?: () => void;
  windowMaximize?: () => void;
  windowClose?: () => void;
}

interface DragRegionProps {
  actions?: React.ReactNode;
}

export function DragRegion({ actions }: DragRegionProps) {
  const [electronAPI, setElectronAPI] = useState<ElectronAPI | null>(null);

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
    if (api?.isElectron) {
      setElectronAPI(api);
    }
  }, []);

  if (!electronAPI) return null;

  const showWindowControls = electronAPI.platform !== "darwin";

  return (
    <div className="drag-region pointer-events-none fixed top-0 right-0 left-0 z-9999">
      {actions && (
        <div
          className={`pointer-events-auto absolute top-0 flex h-full items-center gap-1 ${
            showWindowControls ? "right-[150px]" : "right-3"
          }`}
        >
          {actions}
        </div>
      )}
      {showWindowControls && (
        <div className="pointer-events-auto absolute top-0 right-2 flex h-full items-center">
          <button
            type="button"
            onClick={() => electronAPI.windowMinimize?.()}
            className="flex h-8 w-[46px] items-center justify-center transition-colors hover:bg-foreground/10"
          >
            <Minus className="h-4 w-4 text-foreground/80" />
          </button>
          <button
            type="button"
            onClick={() => electronAPI.windowMaximize?.()}
            className="flex h-8 w-[46px] items-center justify-center transition-colors hover:bg-foreground/10"
          >
            <Square className="h-3 w-3 text-foreground/80" />
          </button>
          <button
            type="button"
            onClick={() => electronAPI.windowClose?.()}
            className="flex h-8 w-[46px] items-center justify-center transition-colors hover:bg-red-500 hover:text-white"
          >
            <X className="h-4 w-4 text-foreground/80 hover:text-inherit" />
          </button>
        </div>
      )}
    </div>
  );
}
