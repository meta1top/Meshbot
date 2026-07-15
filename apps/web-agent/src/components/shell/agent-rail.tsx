"use client";

import {
  cn,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@meshbot/design";
import type { AgentView } from "@meshbot/types-agent";
import { useAtom } from "jotai";
import { Pencil, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { currentAgentIdAtom } from "@/atoms/agent";
import { AgentEditorSheet } from "@/components/agent/agent-editor-sheet";
import { parseAgentAvatar } from "@/lib/agent-avatar";
import { resolveCurrentAgentId } from "@/lib/resolve-current-agent";
import { useAgents } from "@/rest/agents";

/**
 * 单个 Agent 的圆形头像按钮：emoji 前景 + 色值背景，选中态外环高亮。
 *
 * 编辑入口：hover 时右下角浮出铅笔徽标（`opacity-0 group-hover:opacity-100`），
 * 点击 `stopPropagation` 避免同时触发选中——与 `SessionListItem` 的「hover
 * 显示三点菜单」是同一套「常态不占位、hover 才现身」的交互习惯，只是这里
 * 40px 圆形头像放不下三点菜单，退化成一个最小的编辑徽标。选中态点击本身
 * 仍走单击（不新增右键/双击手势，本仓库其它地方也没有这类手势的先例）。
 */
function AgentAvatarButton({
  agent,
  active,
  onClick,
  onEdit,
}: {
  agent: AgentView;
  active: boolean;
  onClick: () => void;
  onEdit: () => void;
}) {
  const t = useTranslations("agent");
  const { emoji, color } = parseAgentAvatar(agent.avatar);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="group/avatar relative shrink-0">
          <button
            type="button"
            onClick={onClick}
            aria-current={active ? "true" : undefined}
            aria-label={agent.name}
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[18px] leading-none transition-all",
              active
                ? "ring-2 ring-(--shell-accent) ring-offset-2 ring-offset-(--shell-chrome)"
                : "opacity-80 hover:opacity-100",
            )}
            style={{ backgroundColor: color }}
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            aria-label={t("editAgent", { name: agent.name })}
            className="absolute -right-0.5 -bottom-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background opacity-0 shadow-sm transition-opacity group-hover/avatar:opacity-100 focus-visible:opacity-100"
          >
            <Pencil className="h-2.5 w-2.5" />
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">{agent.name}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 最左侧 Agent 图标导航条（约 56px 宽）：每个 agent 一个圆形头像按钮，
 * 选中态高亮环，底部 `+` 新建入口，hover 头像浮出编辑徽标（见 Task 11）。
 *
 * 首屏若 currentAgentIdAtom 为 null 或指向已删除的 agent，自动选中列表第一个
 * （逻辑见 `resolveCurrentAgentId`，纯函数、有单测）。
 *
 * 「运行中」脉冲点本期仍未做：Task 12 已经给 `SessionSummary` 补上了
 * `agentId`（前端可以按 agent 聚合 `sessionsAtom` 里 status==="running" 的
 * 会话），但 `sessionsAtom` 的 `status` 字段目前只在首次加载/创建时写入，
 * 没有 WS 事件在 run 开始/结束时实时 patch 它——现在拼出来的脉冲点会在 run
 * 结束后停留不消失，比没有更误导。需要先补一条 run 生命周期 → sessionsAtom
 * status 的实时更新通道，再做这个点，留给后续任务。
 */
export function AgentRail() {
  const t = useTranslations("agent");
  const { data: agents, isLoading } = useAgents();
  const [currentAgentId, setCurrentAgentId] = useAtom(currentAgentIdAtom);
  const [editor, setEditor] = useState<{
    open: boolean;
    agentId: string | null;
  }>({ open: false, agentId: null });

  useEffect(() => {
    if (!agents) return;
    const resolved = resolveCurrentAgentId(agents, currentAgentId);
    if (resolved !== currentAgentId) setCurrentAgentId(resolved);
  }, [agents, currentAgentId, setCurrentAgentId]);

  const handleCreateAgent = () => {
    setEditor({ open: true, agentId: null });
  };

  return (
    <aside
      aria-label={t("railLabel")}
      className="flex h-full w-14 shrink-0 flex-col items-center gap-2 bg-(--shell-chrome) py-3"
    >
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto">
        {isLoading && !agents ? (
          <>
            <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
            <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
          </>
        ) : (
          agents?.map((agent) => (
            <AgentAvatarButton
              key={agent.id}
              agent={agent}
              active={agent.id === currentAgentId}
              onClick={() => setCurrentAgentId(agent.id)}
              onEdit={() => setEditor({ open: true, agentId: agent.id })}
            />
          ))
        )}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleCreateAgent}
            aria-label={t("newAgent")}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white/65 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Plus className="h-5 w-5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{t("newAgent")}</TooltipContent>
      </Tooltip>

      <AgentEditorSheet
        agentId={editor.agentId}
        open={editor.open}
        onOpenChange={(open) => setEditor((s) => ({ ...s, open }))}
      />
    </aside>
  );
}
