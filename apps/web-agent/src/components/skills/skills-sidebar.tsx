"use client";

import type { AgentView, SkillInstallSource } from "@meshbot/types-agent";
import {
  type NavGroup,
  SidebarHeader,
  SidebarNav,
} from "@meshbot/web-common/shell";
import { BookOpen, Package, Store } from "lucide-react";
import { useTranslations } from "next-intl";
import { parseAgentAvatar } from "@/lib/agent-avatar";

/**
 * 页面市场来源仅展示「可搜索/可浏览」的来源（system / clawhub）。
 * GitHub 无搜索逻辑（给仓库地址→下载→安装），不在页面单列入口；
 * Agent 的 skill_install 工具仍支持 github 来源（后端 SkillInstallSource 不变）。
 */
type MarketView = Exclude<SkillInstallSource, "github">;
export type SkillsView = MarketView | "installed";

interface Props {
  /** 全部 Agent（含零技能的），列出供切换——不做任何过滤。 */
  agents: AgentView[];
  /** 当前选中 Agent（页面本地状态，见 skills/page.tsx；不是全局当前态）。 */
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  activeView: SkillsView;
  onSelectView: (view: SkillsView) => void;
}

/**
 * 技能页侧栏：主从视图的「主」——上区列出全部 Agent（点击切换
 * `selectedAgentId`，决定右侧看谁的技能），下区沿用原「已安装 / 市场来源」
 * 视图切换。两组各自独立的 SidebarNav + activeKey，互不干扰。
 */
export function SkillsSidebar({
  agents,
  selectedAgentId,
  onSelectAgent,
  activeView,
  onSelectView,
}: Props) {
  const t = useTranslations("skills");

  const agentGroups: NavGroup[] = [
    {
      key: "agents",
      title: t("agentsSectionTitle"),
      items: agents.map((agent) => {
        const { emoji, color } = parseAgentAvatar(agent.avatar);
        return {
          key: agent.id,
          label: agent.name,
          icon: (
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full text-[11px]"
              style={{ backgroundColor: color }}
            >
              {emoji}
            </span>
          ),
          onClick: () => onSelectAgent(agent.id),
        };
      }),
    },
  ];

  const viewGroups: NavGroup[] = [
    {
      key: "installed",
      items: [
        {
          key: "installed",
          label: t("installed"),
          icon: <Package />,
          onClick: () => onSelectView("installed"),
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
          onClick: () => onSelectView("system"),
        },
        {
          key: "clawhub",
          label: t("sourceClawhub"),
          icon: <BookOpen />,
          onClick: () => onSelectView("clawhub"),
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
          groups={agentGroups}
          activeKey={selectedAgentId ?? undefined}
          onSelect={(n) => onSelectAgent(n.key)}
        />
        <div className="my-2 border-t border-border" />
        <SidebarNav
          groups={viewGroups}
          activeKey={activeView}
          onSelect={(n) => onSelectView(n.key as SkillsView)}
        />
      </div>
    </div>
  );
}
