"use client";

import { cn } from "@meshbot/design";
import type { InstalledSkill, SkillInstallSource } from "@meshbot/types-agent";
import { BookOpen, Github, Store } from "lucide-react";
import { useTranslations } from "next-intl";
import { SidebarSection } from "@/components/shell/sidebar-section";

export type SkillsView = SkillInstallSource | "installed";

interface Props {
  installed: InstalledSkill[];
  activeView: SkillsView;
  onSelect: (view: SkillsView) => void;
}

const MARKET_SOURCES: {
  view: SkillInstallSource;
  icon: React.ReactNode;
  labelKey: string;
}[] = [
  {
    view: "system",
    icon: <Store className="h-3.5 w-3.5 shrink-0 opacity-70" />,
    labelKey: "sourceOurMarket",
  },
  {
    view: "github",
    icon: <Github className="h-3.5 w-3.5 shrink-0 opacity-70" />,
    labelKey: "sourceGithub",
  },
  {
    view: "clawhub",
    icon: <BookOpen className="h-3.5 w-3.5 shrink-0 opacity-70" />,
    labelKey: "sourceClawhub",
  },
];

const rowBase =
  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] transition-colors";

/**
 * 技能页侧栏：「已安装」段（列已装技能条目）+ 「市场来源」段（三入口切换主区视图）。
 */
export function SkillsSidebar({ installed, activeView, onSelect }: Props) {
  const t = useTranslations("skills");

  return (
    <div className="flex h-full flex-col bg-(--shell-sidebar) text-white">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center border-b border-white/8 px-3.5">
        <span className="text-[15px] font-extrabold">{t("title")}</span>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        {/* 已安装段 */}
        <SidebarSection title={t("installed")}>
          {installed.length === 0 ? (
            <div className="px-2 py-1 text-[12px] text-white/55">
              {t("installedEmpty")}
            </div>
          ) : (
            installed.map((skill) => (
              <button
                key={skill.name}
                type="button"
                onClick={() => onSelect("installed")}
                className={cn(
                  rowBase,
                  activeView === "installed"
                    ? "bg-(--shell-accent) text-white"
                    : "text-white/80 hover:bg-white/12",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-left">
                  {skill.name}
                </span>
              </button>
            ))
          )}
          {installed.length > 0 && (
            <button
              type="button"
              onClick={() => onSelect("installed")}
              className={cn(
                rowBase,
                activeView === "installed"
                  ? "bg-(--shell-accent) text-white"
                  : "text-white/80 hover:bg-white/12",
              )}
            >
              <span className="min-w-0 flex-1 truncate text-left">
                {t("viewInstalled")}
              </span>
            </button>
          )}
        </SidebarSection>

        {/* 市场来源段 */}
        <SidebarSection title={t("market")}>
          {MARKET_SOURCES.map(({ view, icon, labelKey }) => (
            <button
              key={view}
              type="button"
              onClick={() => onSelect(view)}
              className={cn(
                rowBase,
                activeView === view
                  ? "bg-(--shell-accent) text-white"
                  : "text-white/80 hover:bg-white/12",
              )}
            >
              {icon}
              <span className="min-w-0 flex-1 truncate text-left">
                {t(
                  labelKey as
                    | "sourceOurMarket"
                    | "sourceGithub"
                    | "sourceClawhub",
                )}
              </span>
            </button>
          ))}
        </SidebarSection>
      </div>
    </div>
  );
}
