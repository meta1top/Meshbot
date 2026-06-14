"use client";

import { useAtomValue } from "jotai";
import { Hash } from "lucide-react";
import { useTranslations } from "next-intl";
import { currentConversationAtom, presenceAtom } from "@/atoms/im";

/**
 * IM 会话顶部标题栏。
 * 频道：# name；私信：peer.displayName + 在线状态圆点。
 * 镜像 session-header.tsx 的样式：h-11 + bg-(--shell-content) + border-b。
 */
export function ImConversationHeader() {
  const t = useTranslations("messages");
  const conv = useAtomValue(currentConversationAtom);
  const presence = useAtomValue(presenceAtom);

  if (!conv) return null;

  const isChannel = conv.type === "channel";
  const peerId = conv.peer?.userId ?? "";
  // peerId 为空字符串（peer 为 null）时，presence[""] 可能误判为在线，
  // 故仅在 peerId 非空时读取在线状态。
  const online = !isChannel && peerId !== "" && (presence[peerId] ?? false);
  const name = isChannel
    ? (conv.name ?? "")
    : (conv.peer?.displayName ?? conv.name ?? "");

  return (
    <div className="shrink-0 border-b border-border bg-(--shell-content)">
      <div className="mx-auto flex h-11 w-full max-w-[900px] items-center gap-2 px-4 lg:px-10">
        {isChannel ? (
          <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${online ? "bg-green-500" : "bg-muted-foreground/40"}`}
            title={online ? t("online") : undefined}
          />
        )}
        <span className="truncate text-[13px] font-semibold text-foreground">
          {name}
        </span>
      </div>
    </div>
  );
}
