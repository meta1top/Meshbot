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
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { currentAgentIdAtom } from "@/atoms/agent";
import { parseAgentAvatar } from "@/lib/agent-avatar";
import { resolveCurrentAgentId } from "@/lib/resolve-current-agent";
import { useAgents } from "@/rest/agents";

/** 单个 Agent 的圆形头像按钮：emoji 前景 + 色值背景，选中态外环高亮。 */
function AgentAvatarButton({
  agent,
  active,
  onClick,
}: {
  agent: AgentView;
  active: boolean;
  onClick: () => void;
}) {
  const { emoji, color } = parseAgentAvatar(agent.avatar);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
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
      </TooltipTrigger>
      <TooltipContent side="right">{agent.name}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 最左侧 Agent 图标导航条（约 56px 宽）：每个 agent 一个圆形头像按钮，
 * 选中态高亮环，底部 `+` 新建入口。
 *
 * 首屏若 currentAgentIdAtom 为 null 或指向已删除的 agent，自动选中列表第一个
 * （逻辑见 `resolveCurrentAgentId`，纯函数、有单测）。
 *
 * 「运行中」脉冲点本期未做：SessionSummary 目前不带 agentId，无法在前端按
 * agent 聚合会话 status 判断是否有会话在跑；接了后端字段后再补，见 Task 10 报告。
 */
export function AgentRail() {
  const t = useTranslations("agent");
  const { data: agents, isLoading } = useAgents();
  const [currentAgentId, setCurrentAgentId] = useAtom(currentAgentIdAtom);

  useEffect(() => {
    if (!agents) return;
    const resolved = resolveCurrentAgentId(agents, currentAgentId);
    if (resolved !== currentAgentId) setCurrentAgentId(resolved);
  }, [agents, currentAgentId, setCurrentAgentId]);

  // Task 11 的编辑抽屉接口点：本任务先接占位，抽屉落地后把这里换成
  // `setCreateDrawerOpen(true)` 之类的状态开关。
  const handleCreateAgent = () => {
    console.log("[agent-rail] TODO(Task 11): 打开新建 Agent 抽屉");
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
    </aside>
  );
}
