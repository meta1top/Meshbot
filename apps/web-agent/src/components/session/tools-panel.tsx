"use client";

import { useAtomValue } from "jotai";
import { Wrench } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef } from "react";
import { currentAssistantSessionIdAtom } from "@/atoms/right-zone";
import { useSessionStream } from "@/hooks/use-session-stream";
import { deriveToolCalls } from "@/lib/derive-tool-calls";
import { toolDisplayName } from "@/lib/tool-display";

/** 工具上下文面板:列出当前主助手会话的工具调用。 */
export function ToolsPanel() {
  const t = useTranslations("rightZone");
  const sessionId = useAtomValue(currentAssistantSessionIdAtom);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stream = useSessionStream(sessionId, scrollRef);
  // 桥接真实 TimelineMessage.toolCalls(字段名 name)到纯函数期望的最小形状
  // (字段名 toolName),派生逻辑本身与具体消息类型解耦、保持可单测。
  const calls = deriveToolCalls(
    stream.messages.map((m) => ({
      toolCalls: m.toolCalls?.map((tc) => ({
        toolCallId: tc.toolCallId,
        toolName: tc.name,
      })),
    })),
  );

  if (!sessionId || calls.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[12px] text-muted-foreground">
        {t("toolsEmpty")}
      </div>
    );
  }
  return (
    <div ref={scrollRef} className="h-full overflow-y-auto p-3">
      {calls.map((c) => (
        <div
          key={c.toolCallId}
          className="mb-1.5 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
        >
          <Wrench className="h-3.5 w-3.5 shrink-0 text-(--brand)" />
          <span className="truncate text-[12px] text-foreground">
            {toolDisplayName(c.toolName)}
          </span>
        </div>
      ))}
    </div>
  );
}
