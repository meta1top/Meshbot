"use client";

import { cn } from "@meshbot/design";
import { useAtom, useAtomValue } from "jotai";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import {
  availableContextTabsAtom,
  effectiveRightTabAtom,
  type RightTab,
  selectedContextTabAtom,
} from "@/atoms/right-zone";
import { ArtifactBody } from "@/components/artifact/artifact-body";
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

/** 产物面板正文（复用 ArtifactBody；标题栏由本容器的 tab 条承担，故只渲染正文）。 */
function ArtifactBodyPane() {
  const artifact = useAtomValue(previewArtifactAtom);
  if (!artifact) return null;
  return (
    <div className="h-full overflow-auto">
      <ArtifactBody
        path={artifact.path}
        url={artifact.url}
        name={artifact.name}
      />
    </div>
  );
}
