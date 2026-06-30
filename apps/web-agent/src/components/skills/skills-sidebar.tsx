"use client";

import type { SkillInstallSource } from "@meshbot/types-agent";
import { BookOpen, Package, Store } from "lucide-react";
import { useTranslations } from "next-intl";
import { SidebarNavItem } from "@/components/shell/sidebar-nav-item";
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
  { view: "system", icon: <Store />, labelKey: "sourceOurMarket" },
  { view: "clawhub", icon: <BookOpen />, labelKey: "sourceClawhub" },
];

/**
 * 技能页侧栏：「已安装」单行入口（技能清单在主区展示）+ 「市场来源」段
 * （system / clawhub 入口切换主区视图）。一级项与文件/更多页共用 SidebarNavItem。
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
        <div className="mb-1.5">
          <SidebarNavItem
            icon={<Package />}
            label={t("installed")}
            active={activeView === "installed"}
            onClick={() => onSelect("installed")}
          />
        </div>

        {/* 市场来源段 */}
        <SidebarSection title={t("market")}>
          {MARKET_SOURCES.map(({ view, icon, labelKey }) => (
            <SidebarNavItem
              key={view}
              icon={icon}
              label={t(labelKey as "sourceOurMarket" | "sourceClawhub")}
              active={activeView === view}
              onClick={() => onSelect(view)}
            />
          ))}
        </SidebarSection>
      </div>
    </div>
  );
}
