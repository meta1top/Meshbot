"use client";

import { useAtomValue } from "jotai";
import { Wrench } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  currentAssistantSessionIdAtom,
  currentAssistantToolCallsAtom,
} from "@/atoms/right-zone";
import { toolDisplayName } from "@/lib/tool-display";

/**
 * 工具上下文面板:列出当前主助手会话的工具调用。
 * 不自行订阅消息流——工具调用数据由 AssistantConversationBody(持有唯一的
 * 会话流订阅)发布到 currentAssistantToolCallsAtom,这里只读。会话 socket 是
 * 无 refcount 的模块单例,若本组件再挂一份订阅,卸载时的退订会把唯一 socket
 * 从房间踢出,冻结主会话的实时流。
 */
export function ToolsPanel() {
  const t = useTranslations("rightZone");
  const sessionId = useAtomValue(currentAssistantSessionIdAtom);
  const calls = useAtomValue(currentAssistantToolCallsAtom);

  if (!sessionId || calls.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[12px] text-muted-foreground">
        {t("toolsEmpty")}
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto p-3">
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
