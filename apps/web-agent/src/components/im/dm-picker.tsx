"use client";

import { DmPicker as DmPickerBase } from "@meshbot/web-common/im";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { currentUserAtom } from "@/atoms/auth";
import { upsertConversationAtom } from "@/atoms/im";
import { createDm } from "@/rest/im";
import { useMembers } from "@/rest/org";

interface DmPickerProps {
  open: boolean;
  onClose: () => void;
  /** Called with the conversation id once the DM is created/found. */
  onNavigate: (conversationId: string) => void;
}

/**
 * DM 选人对话框容器：atoms/rest 数据逻辑 + labels 注入，渲染委托 web-common DmPicker。
 * 拉取当前用户所属 org 的成员列表，排除自身，点击即创建或复用 DM 会话。
 */
export function DmPicker({ open, onClose, onNavigate }: DmPickerProps) {
  const t = useTranslations("messages");
  const currentUser = useAtomValue(currentUserAtom);
  const upsertConversation = useSetAtom(upsertConversationAtom);

  const orgId = currentUser?.org?.id ?? null;
  const { data: members = [], isLoading } = useMembers(orgId);

  // currentUser 为 null（鉴权加载中/失效）时，m.userId !== undefined 恒为 true，
  // 自身会出现在自己的 DM 列表里。仅在 currentUser 存在时计算列表，确保永不列出自身。
  const others = currentUser
    ? members.filter((m) => m.userId !== currentUser.id)
    : [];

  async function handlePick(userId: string) {
    const conv = await createDm(userId);
    upsertConversation(conv);
    onNavigate(conv.id);
  }

  if (!open) return null;

  return (
    <DmPickerBase
      candidates={others}
      loading={isLoading}
      onPick={handlePick}
      onClose={onClose}
      labels={{
        title: t("pickMember"),
        loading: t("loading"),
        empty: t("empty"),
      }}
    />
  );
}
