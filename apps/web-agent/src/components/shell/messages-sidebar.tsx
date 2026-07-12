"use client";

import { ConversationList } from "@meshbot/web-common/im";
import { useAtomValue, useSetAtom } from "jotai";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
  conversationsAtom,
  currentConversationIdAtom,
  presenceAtom,
} from "@/atoms/im";
import { sessionsStatusAtom } from "@/atoms/sessions";
import { loadSidebarAtom } from "@/atoms/sidebar";

/**
 * 统一消息侧栏容器：私信 / 频道两段，均来自 IM atom。助手已迁至独立 `/assistant` 区，
 * 不在此侧栏出现。点击私信/频道→/messages?id=；助手→/assistant?id=。
 *
 * 薄容器：数据来源（conversationsAtom 订阅 / presence / 加载态）+ 路由跳转全留在此，
 * 分组派生 + 行渲染（未读 badge / 在线圆点）交给 web-common 的 ConversationList。
 */
export function MessagesSidebar() {
  const t = useTranslations("messagesSidebar");
  const router = useRouter();
  const pathname = usePathname();

  const conversations = useAtomValue(conversationsAtom);
  const currentConvId = useAtomValue(currentConversationIdAtom);
  const presence = useAtomValue(presenceAtom);

  const sessionsStatus = useAtomValue(sessionsStatusAtom);

  const loadSidebar = useSetAtom(loadSidebarAtom);

  // 单请求聚合加载（/api/sidebar）：loadSidebar 自带 guard——已加载则直接复用全局
  // atom 数据，跨路由切换侧栏重挂时不重复请求、不再闪骨架；骨架只首屏出现一次。
  useEffect(() => {
    void loadSidebar();
  }, [loadSidebar]);

  const loading = sessionsStatus === "idle" || sessionsStatus === "loading";

  // 只在 /messages 页面高亮当前会话，对齐原 `pathname === "/messages" && c.id === currentConvId`。
  const activeId = pathname === "/messages" ? currentConvId : null;

  return (
    <ConversationList
      conversations={conversations}
      activeId={activeId}
      presence={presence}
      loading={loading}
      onSelect={(id) => router.push(`/messages?id=${id}`)}
      onNewMessage={() => router.push("/messages/new")}
      labels={{
        title: t("title"),
        newMessage: t("newMessage"),
        channels: t("channels"),
        directMessages: t("directMessages"),
      }}
    />
  );
}
