"use client";

import { useEffect, useState } from "react";

interface DragRegionProps {
  actions?: React.ReactNode;
}

export function DragRegion({ actions }: DragRegionProps) {
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    const electronAPI = (window as unknown as {
      electronAPI?: { isElectron: boolean; platform?: string };
    }).electronAPI;
    setIsElectron(!!electronAPI?.isElectron);
  }, []);

  if (!isElectron) return null;

  return (
    <div className="drag-region pointer-events-none fixed top-0 right-0 left-0 z-9999">
      {actions && (
        <div className="pointer-events-auto absolute top-0 right-3 flex h-full items-center gap-1">
          {actions}
        </div>
      )}
    </div>
  );
}
