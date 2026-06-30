"use client";

import { useAtomValue } from "jotai";
import { Sparkles } from "lucide-react";
import { sessionsAtom } from "@/atoms/sessions";

export function SessionHeader({ sessionId }: { sessionId: string }) {
  const sessions = useAtomValue(sessionsAtom);
  const session = sessions.find((s) => s.id === sessionId);
  // session 未就绪时渲染标题骨架（而非 null）：标题栏始终先在位，标题随侧栏
  // 聚合到达后填入，避免「正文先出现、标题后补」。
  return (
    <div className="shrink-0 bg-(--shell-content)">
      <div className="flex h-11 w-full items-center gap-2 border-b border-border px-4 lg:px-6">
        {/* 标题前助手标识（与侧栏会话项同款 Sparkles，统一视觉） */}
        <Sparkles className="h-4 w-4 shrink-0 text-(--shell-accent)" />
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
