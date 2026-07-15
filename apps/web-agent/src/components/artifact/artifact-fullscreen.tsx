"use client";

import { useSetAtom } from "jotai";
import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { artifactFullscreenAtom } from "@/atoms/assistant-panel";
import { ArtifactBody } from "./artifact-body";

/** 产物全屏预览（覆盖整屏，Esc / 点关闭退出）。支持 path 源（产物）和 url+name 源（网盘）。 */
export function ArtifactFullscreen({
  path,
  url,
  name,
  remote,
  title,
  agentId,
  onClose,
}: {
  path?: string;
  url?: string;
  name?: string;
  remote?: { deviceId: string; sessionId: string };
  title: string;
  /** 本机产物所属会话的 agentId（Task 12，`remote` 未传时生效）。 */
  agentId?: string;
  onClose: () => void;
}) {
  const setFullscreen = useSetAtom(artifactFullscreenAtom);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 全屏期间置位，让顶栏隐藏助手 ✦ 按钮；卸载复位。
  useEffect(() => {
    setFullscreen(true);
    return () => setFullscreen(false);
  }, [setFullscreen]);

  return createPortal(
    <div className="fullscreen-titlebar-safe fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex h-13 shrink-0 items-center gap-2 border-b border-border px-3.5">
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
        <ArtifactBody
          path={path}
          url={url}
          name={name}
          remote={remote}
          title={title}
          agentId={agentId}
        />
      </div>
    </div>,
    document.body,
  );
}
