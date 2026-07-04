"use client";

import { cn } from "@meshbot/design";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Download, Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import {
  availableContextTabsAtom,
  effectiveRightTabAtom,
  type RightTab,
  selectedContextTabAtom,
} from "@/atoms/right-zone";
import {
  ArtifactBody,
  downloadArtifact,
} from "@/components/artifact/artifact-body";
import { AssistantDock } from "@/components/im/assistant-dock";
import { MembersPanel } from "@/components/im/members-panel";
import { ToolsPanel } from "@/components/session/tools-panel";

/** 右区容器：统一 tab 条（上下文 tab + 钉住 ✦随手问）+ 选中面板。 */
export function RightZone() {
  const t = useTranslations("rightZone");
  const ctx = useAtomValue(availableContextTabsAtom);
  const active = useAtomValue(effectiveRightTabAtom);
  const [, setSelected] = useAtom(selectedContextTabAtom);

  const label: Record<RightTab, string> = {
    quick: t("quick"),
    artifact: t("artifact"),
    tools: t("tools"),
    members: t("members"),
  };

  return (
    <div className="flex h-full w-full flex-col bg-(--shell-content)">
      <div className="flex h-13 shrink-0 items-center gap-1 border-b border-border px-2">
        {ctx.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setSelected(tab)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12px] transition-colors",
              active === tab
                ? "font-semibold text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label[tab]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSelected("quick")}
          className={cn(
            "ml-auto flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors",
            active === "quick"
              ? "bg-(--brand) text-white"
              : "text-(--brand) hover:bg-(--brand)/10",
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {label.quick}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {active === "quick" && <AssistantDock chromeless />}
        {active === "artifact" && <ArtifactBodyPane />}
        {active === "tools" && <ToolsPanel />}
        {active === "members" && <MembersPanel />}
      </div>
    </div>
  );
}

/**
 * 产物面板正文：复用 ArtifactBody + 一条紧凑工具栏（标题 / 下载 / 关闭）。
 * 关闭是当前唯一能清 previewArtifactAtom 的活路径——旧的 ArtifactPreviewPanel
 * 已是死代码，不再挂载；没有这个按钮，产物一旦打开就再也关不掉（I3）。
 */
function ArtifactBodyPane() {
  const t = useTranslations("rightZone");
  const artifact = useAtomValue(previewArtifactAtom);
  const setPreviewArtifact = useSetAtom(previewArtifactAtom);
  const setSelectedContextTab = useSetAtom(selectedContextTabAtom);
  if (!artifact) return null;
  // 标题：优先 title，其次 name（网盘源），其次 path 末段（产物源）
  const title =
    artifact.title ??
    artifact.name ??
    artifact.path?.split("/").pop() ??
    t("artifactUntitled");
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
          {title}
        </span>
        <button
          type="button"
          onClick={() =>
            void downloadArtifact({
              path: artifact.path,
              url: artifact.url,
              name: title,
            })
          }
          title={t("artifactDownload")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            setPreviewArtifact(null);
            setSelectedContextTab(null);
          }}
          title={t("artifactClose")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ArtifactBody
          path={artifact.path}
          url={artifact.url}
          name={artifact.name}
        />
      </div>
    </div>
  );
}
