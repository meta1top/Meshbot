"use client";

import { cn } from "@meshbot/design";
import type { SkillInstallSource } from "@meshbot/types-agent";
import { BookOpen, Package, Store } from "lucide-react";
import { useTranslations } from "next-intl";
import { SidebarSection } from "@/components/shell/sidebar-section";

/**
 * 页面市场来源仅展示「可搜索/可浏览」的来源（system / clawhub）。
 * GitHub 无搜索逻辑（给仓库地址→下载→安装），不在页面单列入口；
 * Agent 的 skill_install 工具仍支持 github 来源（后端 SkillInstallSource 不变）。
 */
type MarketView = Exclude<SkillInstallSource, "github">;
export type SkillsView = MarketView | "installed";

interface Props {
  activeView: SkillsView;
  onSelect: (view: SkillsView) => void;
}

const MARKET_SOURCES: {
  view: MarketView;
  icon: React.ReactNode;
  labelKey: string;
}[] = [
  {
    view: "system",
    icon: <Store className="h-3.5 w-3.5 shrink-0 opacity-70" />,
    labelKey: "sourceOurMarket",
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
 * 技能页侧栏：「已安装」单行入口（技能清单在主区展示，侧栏不再逐条列）+
 * 「市场来源」段（system / clawhub 入口切换主区视图）。
 */
export function SkillsSidebar({ activeView, onSelect }: Props) {
  const t = useTranslations("skills");

  return (
    <div className="flex h-full flex-col bg-(--shell-sidebar) text-white">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center border-b border-white/8 px-3.5">
        <span className="text-[15px] font-extrabold">{t("title")}</span>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        {/* 已安装入口（单行） */}
        <button
          type="button"
          onClick={() => onSelect("installed")}
          className={cn(
            rowBase,
            "mb-1.5",
            activeView === "installed"
              ? "bg-(--shell-accent) text-white"
              : "text-white/80 hover:bg-white/12",
          )}
        >
          <Package className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate text-left">
            {t("installed")}
          </span>
        </button>

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
                {t(labelKey as "sourceOurMarket" | "sourceClawhub")}
              </span>
            </button>
          ))}
        </SidebarSection>
      </div>
    </div>
  );
}
