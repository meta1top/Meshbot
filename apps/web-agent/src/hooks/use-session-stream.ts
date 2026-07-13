"use client";

import type {
  MessageUsage,
  RunUsageEvent,
  SessionUsage,
} from "@meshbot/types-agent";
import type { SessionTransport } from "@meshbot/web-common/session";
import {
  type SessionStream,
  type TimelineMessage,
  useSessionStream as useSessionStreamCore,
} from "@meshbot/web-common/session";
import { useSetAtom } from "jotai";
import { useCallback } from "react";
import {
  appendUsageAtom,
  appendUsageByMessageAtom,
  resetUsageAtom,
  setInitialUsageAtom,
} from "@/atoms/session-usage";
import { updateSessionTitleAtom } from "@/atoms/sessions";
import { getSessionSocket } from "@/lib/socket";

// `TimelineMessage` 原在本文件消费方处从 `@/components/session/message-list`
// 拿（该文件已 re-export web-common 的定义），此处额外整体 re-export 一份，
// 供直接从 `@/hooks/use-session-stream` 取类型的调用方零改动（如有）。
export type { SessionStream, TimelineMessage };

/**
 * web-agent 薄桥：包 `@meshbot/web-common/session` 的 `useSessionStream`，把
 * web-common 侧回调化的 usage/标题写入点接回本应用的 jotai atoms，并注入
 * `getSessionSocket`（app 专属 socket 单例）。
 *
 * 公开签名与迁移前逐位一致（`sessionId, scrollContainerRef, transport,
 * remoteDeviceId?, remoteInitialStreamId?`），3 个消费方
 * （assistant-conversation-body.tsx / assistant-dock.tsx / subagent-card.tsx）
 * 零改动。
 */
export function useSessionStream(
  sessionId: string | null,
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
  transport: SessionTransport,
  remoteDeviceId?: string | null,
  remoteInitialStreamId?: string | null,
): SessionStream {
  const setInitialUsage = useSetAtom(setInitialUsageAtom);
  const appendUsage = useSetAtom(appendUsageAtom);
  const appendUsageByMessage = useSetAtom(appendUsageByMessageAtom);
  const resetUsage = useSetAtom(resetUsageAtom);
  const updateSessionTitle = useSetAtom(updateSessionTitleAtom);

  const onUsageReset = useCallback(
    (sid: string) => resetUsage(sid),
    [resetUsage],
  );
  const onUsageInitial = useCallback(
    (sid: string, usage: SessionUsage) =>
      setInitialUsage({ sessionId: sid, usage }),
    [setInitialUsage],
  );
  const onUsageEvent = useCallback(
    (sid: string, event: RunUsageEvent) =>
      appendUsage({ sessionId: sid, event }),
    [appendUsage],
  );
  const onUsageBatch = useCallback(
    (sid: string, batch: Record<string, MessageUsage>) =>
      appendUsageByMessage({ sessionId: sid, batch }),
    [appendUsageByMessage],
  );
  const onTitleUpdated = useCallback(
    (sid: string, title: string) => updateSessionTitle({ id: sid, title }),
    [updateSessionTitle],
  );

  return useSessionStreamCore(
    sessionId,
    scrollContainerRef,
    transport,
    getSessionSocket,
    {
      onUsageReset,
      onUsageInitial,
      onUsageEvent,
      onUsageBatch,
      onTitleUpdated,
    },
    remoteDeviceId,
    remoteInitialStreamId,
  );
}
