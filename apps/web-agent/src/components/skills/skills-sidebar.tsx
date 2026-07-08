"use client";

import type { SkillInstallSource } from "@meshbot/types-agent";
import {
  type NavGroup,
  SidebarHeader,
  SidebarNav,
} from "@meshbot/web-common/shell";
import { BookOpen, Package, Store } from "lucide-react";
import { useTranslations } from "next-intl";

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

/**
 * 技能页侧栏：「已安装」单行入口（技能清单在主区展示）+ 「市场来源」段
 * （system / clawhub 入口切换主区视图）。数据驱动 SidebarNav + NavGroup。
 */
export function SkillsSidebar({ activeView, onSelect }: Props) {
  const t = useTranslations("skills");
  const groups: NavGroup[] = [
    {
      key: "installed",
      items: [
        {
          key: "installed",
          label: t("installed"),
          icon: <Package />,
          onClick: () => onSelect("installed"),
        },
      ],
    },
    {
      key: "market",
      title: t("market"),
      items: [
        {
          key: "system",
          label: t("sourceOurMarket"),
          icon: <Store />,
          onClick: () => onSelect("system"),
        },
        {
          key: "clawhub",
          label: t("sourceClawhub"),
          icon: <BookOpen />,
          onClick: () => onSelect("clawhub"),
        },
      ],
    },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <SidebarHeader title={t("title")} />

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        <SidebarNav
          groups={groups}
          activeKey={activeView}
          onSelect={(n) => onSelect(n.key as SkillsView)}
        />
      </div>
    </div>
  );
}
