"use client";

import { useAtomValue } from "jotai";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { currentConversationAtom } from "@/atoms/im";
import {
  describeRoute,
  formatLlmuseBlock,
  type LlmuseConversation,
} from "@/lib/llmuse";

/**
 * 返回一个把当前前端 UI 状态拼成隐藏 `<llmuse>` 块并前置到消息的函数。
 *
 * 读取当前路由（页面）+ 当前打开的会话（频道/私聊及未读），仅用于「用户→助手」发送。
 */
export function useLlmusePrefix(): (text: string) => string {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isAssistant = searchParams.get("kind") === "assistant";
  const conv = useAtomValue(currentConversationAtom);

  return useCallback(
    (text: string) => {
      const conversation: LlmuseConversation | null = conv
        ? {
            id: conv.id,
            type: conv.type,
            name: conv.name ?? conv.peer?.displayName ?? conv.id,
            unread: conv.unreadCount,
          }
        : null;
      const block = formatLlmuseBlock({
        pageLabel: describeRoute(pathname, isAssistant),
        conversation,
      });
      return `${block}\n${text}`;
    },
    [pathname, isAssistant, conv],
  );
}
