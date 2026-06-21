"use client";

import { useAtomValue } from "jotai";
import { Sparkles } from "lucide-react";
import { sessionsAtom } from "@/atoms/sessions";

export function SessionHeader({ sessionId }: { sessionId: string }) {
  const sessions = useAtomValue(sessionsAtom);
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  return (
    <div className="shrink-0 bg-(--shell-content)">
      <div className="flex h-11 w-full items-center gap-2 border-b border-border px-4 lg:px-6">
        {/* 标题前助手标识（与侧栏会话项同款 Sparkles，统一视觉） */}
        <Sparkles className="h-4 w-4 shrink-0 text-(--shell-accent)" />
        <span className="truncate text-[13px] font-semibold text-foreground">
          {session.title}
        </span>
      </div>
    </div>
  );
}
