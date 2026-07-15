"use client";

import { useAtomValue } from "jotai";
import { sessionsAtom } from "@/atoms/sessions";
import { parseAgentAvatar } from "@/lib/agent-avatar";
import { useAgents } from "@/rest/agents";

export function SessionHeader({ sessionId }: { sessionId: string }) {
  const sessions = useAtomValue(sessionsAtom);
  const session = sessions.find((s) => s.id === sessionId);
  const { data: agents } = useAgents();
  const agent = session
    ? agents?.find((a) => a.id === session.agentId)
    : undefined;
  // session 未就绪时渲染标题骨架（而非 null）：标题栏始终先在位，标题随侧栏
  // 聚合到达后填入，避免「正文先出现、标题后补」。
  return (
    <div className="shrink-0 bg-(--shell-content)">
      <div className="flex h-13 w-full items-center gap-2 border-b border-border px-4 lg:px-6">
        {agent ? (
          <span className="flex shrink-0 items-center gap-1.5">
            {(() => {
              const { emoji, color } = parseAgentAvatar(agent.avatar);
              return (
                <span
                  className="flex h-5 w-5 items-center justify-center rounded-full text-[11px]"
                  style={{ backgroundColor: color }}
                >
                  {emoji}
                </span>
              );
            })()}
            <span className="text-[13px] font-medium text-foreground/70">
              {agent.name}
            </span>
            {/* 设备位：2a 预留不填，2c 在此标宿主设备 */}
          </span>
        ) : null}
        {session ? (
          <span className="truncate text-[15px] font-semibold text-foreground">
            {session.title}
          </span>
        ) : (
          <div className="h-3.5 w-32 animate-pulse rounded bg-muted" />
        )}
      </div>
    </div>
  );
}
