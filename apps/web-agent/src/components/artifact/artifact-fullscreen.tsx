"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ArtifactBody } from "./artifact-body";

/** 产物全屏预览（覆盖整屏，Esc / 点关闭退出）。 */
export function ArtifactFullscreen({
  path,
  title,
  onClose,
}: {
  path: string;
  title: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3.5">
        <span className="min-w-0 flex-1 truncate text-[14px] font-bold text-foreground">
          {title}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="退出全屏"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ArtifactBody path={path} />
      </div>
    </div>,
    document.body,
  );
}
