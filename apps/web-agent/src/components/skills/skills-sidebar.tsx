"use client";

import type { AgentView, SkillInstallSource } from "@meshbot/types-agent";
import {
  type NavGroup,
  SidebarHeader,
  SidebarNav,
} from "@meshbot/web-common/shell";
import { BookOpen, Store } from "lucide-react";
import { useTranslations } from "next-intl";
import { parseAgentAvatar } from "@/lib/agent-avatar";

/**
 * 页面市场来源仅展示「可搜索/可浏览」的来源（system / clawhub）。
 * GitHub 无搜索逻辑（给仓库地址→下载→安装），不在页面单列入口；
 * Agent 的 skill_install 工具仍支持 github 来源（后端 SkillInstallSource 不变）。
 */
type MarketView = Exclude<SkillInstallSource, "github">;
export type SkillsView = MarketView;

/**
 * 左栏两种互斥模式：`"agent"` 看某个 Agent 已装技能（谁由 selectedAgentId
 * 决定），`"market"` 看技能市场（哪个来源由 activeView 决定）。二者互斥——
 * 不存在「Agent 与市场同时高亮」的中间态，去掉了旧版单独的「已安装」菜单项。
 */
export type SkillsMode = "agent" | "market";

interface Props {
  /** 全部 Agent（含零技能的），列出供切换——不做任何过滤。 */
  agents: AgentView[];
  /** 当前选中 Agent（页面本地状态，见 skills/page.tsx；不是全局当前态）。 */
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  /** 当前互斥模式：agent 态才高亮 Agent 列表，market 态才高亮市场来源。 */
  mode: SkillsMode;
  activeView: SkillsView;
  onSelectView: (view: SkillsView) => void;
}

/**
 * 技能页侧栏：主从视图的「主」——上区列出全部 Agent（点击切换
 * `selectedAgentId` 并进入 agent 态），下区是「技能市场」入口（点击任一
 * 来源即进入 market 态）。两组各自独立的 SidebarNav，但 activeKey 按 `mode`
 * 二选一点亮——同一时刻只有一组处于高亮状态，不会出现 Agent 与市场同时
 * 选中的冗余态（Bug #3）。
 */
export function SkillsSidebar({
  agents,
  selectedAgentId,
  onSelectAgent,
  mode,
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

  const marketGroups: NavGroup[] = [
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
          activeKey={
            mode === "agent" ? (selectedAgentId ?? undefined) : undefined
          }
          onSelect={(n) => onSelectAgent(n.key)}
        />
        <div className="my-2 border-t border-border" />
        <SidebarNav
          groups={marketGroups}
          activeKey={mode === "market" ? activeView : undefined}
          onSelect={(n) => onSelectView(n.key as SkillsView)}
        />
      </div>
    </div>
  );
}
