"use client";

import {
  ChannelPicker as ChannelPickerBase,
  type CreateChannelInput,
} from "@meshbot/web-common/im";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { currentUserAtom } from "@/atoms/auth";
import { upsertConversationAtom } from "@/atoms/im";
import { createChannel } from "@/rest/im";
import { useMembers } from "@/rest/org";

interface ChannelPickerProps {
  open: boolean;
  onClose: () => void;
  /** 创建成功后导航到新频道 */
  onNavigate: (conversationId: string) => void;
}

/**
 * 创建频道弹框容器：atoms/rest 数据逻辑 + labels 注入，渲染委托 web-common ChannelPicker。
 */
export function ChannelPicker({
  open,
  onClose,
  onNavigate,
}: ChannelPickerProps) {
  const t = useTranslations("messages");
  const currentUser = useAtomValue(currentUserAtom);
  const upsertConversation = useSetAtom(upsertConversationAtom);

  const orgId = currentUser?.org?.id ?? null;
  const { data: members = [], isLoading } = useMembers(orgId);

  // 排除自身
  const others = currentUser
    ? members.filter((m) => m.userId !== currentUser.id)
    : [];

  async function handleCreate(input: CreateChannelInput) {
    const conv = await createChannel(
      input.name,
      input.visibility,
      input.memberIds,
    );
    upsertConversation(conv);
    onNavigate(conv.id);
  }

  if (!open) return null;

  return (
    <ChannelPickerBase
      candidates={others}
      loading={isLoading}
      onCreate={handleCreate}
      onClose={onClose}
      labels={{
        title: t("newChannel"),
        nameLabel: t("channelNameLabel"),
        namePlaceholder: t("channelNamePlaceholder"),
        visibilityLabel: t("channelVisibilityLabel"),
        visibilityPublic: t("channelVisibilityPublic"),
        visibilityPrivate: t("channelVisibilityPrivate"),
        initialMembers: t("channelInitialMembers"),
        noMembers: t("channelNoMembers"),
        loading: t("loading"),
        cancel: t("channelCancel"),
        create: t("channelCreate"),
        creating: t("channelCreating"),
      }}
    />
  );
}
