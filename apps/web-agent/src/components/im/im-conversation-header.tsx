"use client";

import type { ChannelMember } from "@meshbot/types";
import {
  ConversationHeader,
  type ConversationHeaderLabels,
} from "@meshbot/web-common/im";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { currentUserAtom } from "@/atoms/auth";
import {
  currentConversationAtom,
  presenceAtom,
  removeConversationAtom,
} from "@/atoms/im";
import { addChannelMember, leaveChannel, listChannelMembers } from "@/rest/im";
import { useMembers } from "@/rest/org";

/**
 * IM 会话顶部标题栏容器：atoms 订阅 + REST 数据逻辑 + labels 注入，渲染委托 web-common ConversationHeader。
 */
export function ImConversationHeader() {
  const t = useTranslations("messages");
  const conv = useAtomValue(currentConversationAtom);
  const presence = useAtomValue(presenceAtom);
  const currentUser = useAtomValue(currentUserAtom);
  const removeConversation = useSetAtom(removeConversationAtom);

  const isPrivateChannel =
    !!conv && conv.type === "channel" && conv.visibility === "private";

  // 私有频道当前成员：随会话切换重新拉取（镜像原 PrivateChannelControls mount 时机）。
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const loadMembers = useCallback(async () => {
    if (!conv || !isPrivateChannel) return;
    try {
      const data = await listChannelMembers(conv.id);
      setMembers(data);
    } catch {
      // 静默失败，保留上次结果
    }
  }, [conv, isPrivateChannel]);
  useEffect(() => {
    if (!isPrivateChannel) {
      setMembers([]);
      return;
    }
    void loadMembers();
  }, [isPrivateChannel, loadMembers]);

  // 添加成员候选：org 成员列表，惰性拉取——仅在用户首次打开"添加成员"对话框后才启用查询，
  // 与原 AddMemberDialog 挂载才触发 useMembers 的时机保持一致。
  const [addDialogOpened, setAddDialogOpened] = useState(false);
  const orgId = currentUser?.org?.id ?? null;
  const { data: orgMembers = [], isLoading: memberCandidatesLoading } =
    useMembers(addDialogOpened ? orgId : null);
  const memberCandidates = currentUser
    ? orgMembers.filter((m) => m.userId !== currentUser.id)
    : [];

  const handleAddMember = useCallback(
    async (userId: string) => {
      if (!conv) return;
      await addChannelMember(conv.id, userId);
      await loadMembers();
    },
    [conv, loadMembers],
  );

  const handleLeave = useCallback(async () => {
    if (!conv) return;
    await leaveChannel(conv.id);
    // 乐观移除：后端也会推 conversationRemoved socket 事件做兜底
    removeConversation(conv.id);
  }, [conv, removeConversation]);

  const labels: ConversationHeaderLabels = {
    online: t("online"),
    privateChannelMembers: t("privateChannelMembers"),
    privateChannelAddMember: t("privateChannelAddMember"),
    privateChannelNoMoreMembers: t("privateChannelNoMoreMembers"),
    privateChannelLeave: t("privateChannelLeave"),
    privateChannelLeaving: t("privateChannelLeaving"),
    privateChannelLeaveConfirm: (name) =>
      t("privateChannelLeaveConfirm", { name }),
    channelCancel: t("channelCancel"),
    loading: t("loading"),
  };

  return (
    <ConversationHeader
      conversation={conv}
      members={members}
      memberCandidates={memberCandidates}
      memberCandidatesLoading={memberCandidatesLoading}
      presence={presence}
      onAddMember={handleAddMember}
      onAddDialogOpen={() => setAddDialogOpened(true)}
      onLeave={handleLeave}
      labels={labels}
    />
  );
}
