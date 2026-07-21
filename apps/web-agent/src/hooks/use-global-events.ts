"use client";

import type {
  ConversationSummary,
  GlobalEventEnvelope,
  ImConversationReadEvent,
  ImMessage,
  PresenceState,
} from "@meshbot/types";
import { AUTH_WS_EVENTS, IM_WS_EVENTS } from "@meshbot/types";
import {
  AGENT_EVENTS,
  MODEL_CONFIG_EVENTS,
  QUICK_ASSISTANT_EVENTS,
  type QuickAssistantRenamedEvent,
  REMOTE_AGENT_EVENTS,
  type RemoteAgentSessionEventPayload,
  SCHEDULE_EVENTS,
  type ScheduleFiredEvent,
  SESSION_LIFECYCLE_EVENTS,
  SESSION_STATUS_EVENTS,
  type SessionStatusChangedEvent,
} from "@meshbot/types-agent";
import { clearAccessToken } from "@meshbot/web-common";
import {
  type SessionListEvent,
  toSessionListEvent,
} from "@meshbot/web-common/session/session-list-events";
import { useQueryClient } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { activeAssistantSessionAtom } from "@/atoms/active-session";
import { quickAssistantNameAtom } from "@/atoms/assistant-panel";
import { applyDevicePresenceAtom } from "@/atoms/devices";
import { globalAlertMessageAtom } from "@/atoms/global-alert";
import {
  applyIncomingMessageAtom,
  markConversationReadAtom,
  removeConversationAtom,
  setPresenceAtom,
  upsertConversationAtom,
} from "@/atoms/im";
import {
  applyRemoteSessionListEventAtom,
  reloadTrackedRemoteSessionsAtom,
} from "@/atoms/remote-sessions";
import { addScheduleActivityAtom } from "@/atoms/schedule-activity";
import {
  applySessionListEventAtom,
  selfDeletingSessionIdsAtom,
  updateSessionStatusAtom,
} from "@/atoms/sessions";
import { getEventsSocket } from "@/lib/events-socket";
import { isActiveSessionDeletedByEvent } from "@/lib/session-deleted-elsewhere";
import { agentsQueryKey } from "@/rest/agents";
import {
  applyRemoteAgentPresence,
  remoteAgentsQueryKey,
} from "@/rest/remote-agents";

/** 全局事件分发表：按信封 type 调对应 handler。纯函数，便于单测。 */
export interface GlobalEventHandlers {
  onMessage: (p: ImMessage) => void;
  onPresence: (p: PresenceState) => void;
  onConversationCreated: (p: ConversationSummary) => void;
  onConversationRemoved: (p: { conversationId: string }) => void;
  onConversationRead: (p: ImConversationReadEvent) => void;
  onScheduleFired: (p: ScheduleFiredEvent) => void;
  onSessionStatusChanged: (p: SessionStatusChangedEvent) => void;
  /**
   * 会话生命周期事件（created/deleted/renamed）已归一为 SessionListEvent——
   * 三个信封 type 共用同一个 handler，与 `@meshbot/web-common/session` 的
   * `applySessionListEvent` 消费端签名对齐（本地/远程共用一套模型）。
   */
  onSessionListEvent: (evt: SessionListEvent) => void;
  onQuickAssistantRenamed: (p: QuickAssistantRenamedEvent) => void;
  onAgentChanged: () => void;
  onModelConfigUpdated: () => void;
  onRemoteAgentsChanged: () => void;
  /**
   * 远程 Agent 的会话生命周期镜像（Agent 级观察通道）。与
   * `onSessionStatusChanged`（本机会话）分开：payload 里的 agentId 是**云端**
   * Agent id，落到远程 Agent 视图的会话列表，不能混进本机列表。
   */
  onRemoteAgentSessionEvent: (p: RemoteAgentSessionEventPayload) => void;
  onReauthRequired: (p: { cloudUserId: string }) => void;
}

export function dispatchGlobalEvent(
  env: GlobalEventEnvelope,
  h: GlobalEventHandlers,
): void {
  switch (env.type) {
    case IM_WS_EVENTS.message:
      h.onMessage(env.payload as ImMessage);
      break;
    case IM_WS_EVENTS.presence:
      h.onPresence(env.payload as PresenceState);
      break;
    case IM_WS_EVENTS.conversationCreated:
      h.onConversationCreated(env.payload as ConversationSummary);
      break;
    case IM_WS_EVENTS.conversationRemoved:
      h.onConversationRemoved(env.payload as { conversationId: string });
      break;
    case IM_WS_EVENTS.conversationRead:
      h.onConversationRead(env.payload as ImConversationReadEvent);
      break;
    case SCHEDULE_EVENTS.fired:
      h.onScheduleFired(env.payload as ScheduleFiredEvent);
      break;
    case SESSION_STATUS_EVENTS.changed:
      h.onSessionStatusChanged(env.payload as SessionStatusChangedEvent);
      break;
    // 会话生命周期事件（created/deleted/renamed）三个信封 type 共用一套归一
    // 逻辑：ws 信封原生就是 (event, payload) 形状，`toSessionListEvent` 正是
    // 为这个形状设计的入口——归一失败（理论不该发生，防御性）返回 null，
    // 原样丢弃，不调用 handler。
    case SESSION_LIFECYCLE_EVENTS.created:
    case SESSION_LIFECYCLE_EVENTS.deleted:
    case SESSION_LIFECYCLE_EVENTS.renamed: {
      const evt = toSessionListEvent(env.type, env.payload);
      if (evt) h.onSessionListEvent(evt);
      break;
    }
    case QUICK_ASSISTANT_EVENTS.renamed:
      h.onQuickAssistantRenamed(env.payload as QuickAssistantRenamedEvent);
      break;
    case AGENT_EVENTS.changed:
      h.onAgentChanged();
      break;
    case MODEL_CONFIG_EVENTS.updated:
      h.onModelConfigUpdated();
      break;
    case REMOTE_AGENT_EVENTS.registryChanged:
      h.onRemoteAgentsChanged();
      break;
    // Agent 级观察通道（T19）：远程 Agent 的会话生命周期镜像，专属信封（不
    // 复用本地 SESSION_LIFECYCLE_EVENTS.* ——那条总线的下游会把远程会话误插
    // 进本机列表，见 REMOTE_AGENT_EVENTS.sessionEvent 的 JSDoc）。payload 原样
    // 透传给 handler，归一/合并逻辑交给调用方（useGlobalEvents 的实现）。
    case REMOTE_AGENT_EVENTS.sessionEvent:
      h.onRemoteAgentSessionEvent(
        env.payload as RemoteAgentSessionEventPayload,
      );
      break;
    case AUTH_WS_EVENTS.reauthRequired:
      h.onReauthRequired(env.payload as { cloudUserId: string });
      break;
    default:
      break;
  }
}

/**
 * 云端凭据吊销 → 清本地 token（全量登出）+ 硬跳 /login。
 * 用 `window.location.href` 而非 router.replace：硬跳顺带清空内存中的
 * react-query 缓存 / jotai atom 状态，避免过期数据残留，简单可靠。
 */
function handleReauthRequired(): void {
  clearAccessToken();
  window.location.href = "/login";
}

/**
 * Shell 级全局事件总线订阅（常驻，挂在 (shell)/layout）。单一 `event` 信封 → 按 type
 * 分发到 atom：IM 消息/在线/会话增删/已读、定时任务触发。任何页面都实时。
 */
export function useGlobalEvents(): void {
  const t = useTranslations("assistantSidebar");
  const router = useRouter();
  const applyIncomingMessage = useSetAtom(applyIncomingMessageAtom);
  const setPresence = useSetAtom(setPresenceAtom);
  const applyDevicePresence = useSetAtom(applyDevicePresenceAtom);
  const setGlobalAlertMessage = useSetAtom(globalAlertMessageAtom);
  const upsertConversation = useSetAtom(upsertConversationAtom);
  const removeConversation = useSetAtom(removeConversationAtom);
  const markConversationRead = useSetAtom(markConversationReadAtom);
  const addScheduleActivity = useSetAtom(addScheduleActivityAtom);
  const setQuickAssistantName = useSetAtom(quickAssistantNameAtom);
  const updateSessionStatus = useSetAtom(updateSessionStatusAtom);
  const applySessionListEventToStore = useSetAtom(applySessionListEventAtom);
  const applyRemoteSessionListEvent = useSetAtom(
    applyRemoteSessionListEventAtom,
  );
  const reloadTrackedRemoteSessions = useSetAtom(
    reloadTrackedRemoteSessionsAtom,
  );
  const queryClient = useQueryClient();

  // 缺陷 1（删除会话后主内容区不跟随）：判断「用户正盯着看的会话」需要它在
  // socket 事件到达那一刻的最新值——本机路由参数驱动的 activeAssistantSessionAtom
  // 与 deleteSessionAtom 写的 selfDeletingSessionIdsAtom 都经 ref 读取，不放进
  // 下方订阅 effect 的依赖数组：否则每次切换会话/每次点删除都会触发 socket
  // 重新订阅（对齐本文件 onSessionListEvent 等回调一律经 ref 取最新值的既有写法）。
  const activeSession = useAtomValue(activeAssistantSessionAtom);
  const activeSessionRef = useRef(activeSession);
  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);
  const selfDeletingIds = useAtomValue(selfDeletingSessionIdsAtom);
  const selfDeletingIdsRef = useRef(selfDeletingIds);
  useEffect(() => {
    selfDeletingIdsRef.current = selfDeletingIds;
  }, [selfDeletingIds]);

  useEffect(() => {
    const socket = getEventsSocket();
    const handlers: GlobalEventHandlers = {
      onMessage: (p) => applyIncomingMessage(p),
      onPresence: (p) => {
        setPresence(p);
        applyDevicePresence(p);
        applyRemoteAgentPresence(queryClient, p);
      },
      onConversationCreated: (p) => upsertConversation(p),
      onConversationRemoved: (p) => removeConversation(p.conversationId),
      onConversationRead: (p) => markConversationRead(p.conversationId),
      onScheduleFired: (p) => addScheduleActivity(p.sessionId),
      // 会话跑完/开跑 → 侧栏「运行中」绿点实时熄灭/点亮（列表里没有的会话忽略）
      onSessionStatusChanged: (p) =>
        updateSessionStatus({ id: p.sessionId, status: p.status }),
      // 会话新建/删除/改名 → 侧栏会话列表实时增删改（applySessionListEvent
      // 统一归并，created 插入 / deleted 移除 / renamed 改标题，不认识的
      // 会话一律忽略，不凭空造行）
      onSessionListEvent: (evt) => {
        applySessionListEventToStore(evt);
        // 缺陷 1：用户正打开的本机会话被删除（另一台设备操作，或本设备自己
        // 删除但已过宽限期——理论不该发生）→ 主内容区不能继续显示已经不存在
        // 的对话，提示 + 跳回起手台（复用「手动删除当前会话」既有的
        // router.push("/assistant") 落点，见 assistant-sidebar.tsx 的
        // onDeleteSession / session-list-item.tsx 的 handleDeleteConfirm）。
        if (
          isActiveSessionDeletedByEvent({
            evt,
            scope: "local",
            active: activeSessionRef.current,
            selfDeletingIds: selfDeletingIdsRef.current,
          })
        ) {
          setGlobalAlertMessage(t("sessionDeletedElsewhere"));
          router.push("/assistant");
        }
      },
      onQuickAssistantRenamed: (p) => setQuickAssistantName(p.name),
      // 本机任一 Agent 增删改（表单 / rename_agent 工具 / 另一个窗口）→ 重拉
      //  Agent 列表：侧栏 Agent 行与会话标题栏共用这份缓存，改名后立刻跟着变
      onAgentChanged: () =>
        queryClient.invalidateQueries({ queryKey: agentsQueryKey }),
      // 云端模型配置同步完成 → 刷新模型列表（选择器/设置页实时更新）
      onModelConfigUpdated: () =>
        queryClient.invalidateQueries({ queryKey: ["model-configs"] }),
      // 任一设备改了「允许远程」开关 / Agent 元数据 → 重拉远程 Agent 列表
      //（侧栏与起手台共用同一份缓存，关掉开关的 Agent 立即消失）
      onRemoteAgentsChanged: () =>
        queryClient.invalidateQueries({ queryKey: remoteAgentsQueryKey }),
      // Agent 级观察通道（T19）：远程 Agent 的会话生命周期镜像 → 归一
      // （toSessionListEvent）后合并进该远程 Agent 的会话列表缓存
      // （remoteSessionsAtom，按 agentId 隔离，不碰本机 sessionsAtom）。
      // 归一失败（畸形帧，理论不该发生）返回 null，原样丢弃。
      onRemoteAgentSessionEvent: (p) => {
        const evt = toSessionListEvent(p.event, p.payload);
        if (evt) applyRemoteSessionListEvent({ agentId: p.agentId, evt });
        // 缺陷 1 远程分支：用户正打开的远程会话被删除（宿主设备那边删的——
        // 远程会话在本应用没有删除入口，不需要自删抑制）→ 同本机分支的
        // 提示 + 跳回起手台。
        if (
          evt &&
          isActiveSessionDeletedByEvent({
            evt,
            scope: { agentId: p.agentId },
            active: activeSessionRef.current,
          })
        ) {
          setGlobalAlertMessage(t("sessionDeletedElsewhere"));
          router.push("/assistant");
        }
      },
      onReauthRequired: () => handleReauthRequired(),
    };
    const onEvent = (env: GlobalEventEnvelope) =>
      dispatchGlobalEvent(env, handlers);
    // 连接/重连成功即刷新模型列表 + 远程 Agent 列表：登录完成瞬间 syncNow 的
    // model-config.updated 事件可能早于本 socket 建立而被错过（授权后「组织没有
    // 模型」假象）；远程 Agent 同理，且还要兜住「本机离线期间别的设备改了开关」
    // 以及云端广播的两个盲区（设备无 orgId / 两台设备 orgId 不同 → 事件投不到，
    // 见 EventsGateway.onRemoteAgentsChanged 的 JSDoc）。幂等且便宜。
    // 本地 Agent 列表同理补拉：断线期间 `rename_agent` 工具或别的窗口改了名，
    // agent.changed 信封会丢，重连时重拉一次兜住。
    // 远程会话列表同理补拉（T19）：断线期间 Agent 级观察通道的镜像帧会丢，
    // 仅凭 onRemoteAgentSessionEvent 的增量合并补不回来——reloadTrackedRemoteSessionsAtom
    // 只强制重拉当前已经加载过（map 里已有 key）的远程 Agent，不主动加载
    // 用户从未展开过的。
    const onConnect = () => {
      queryClient.invalidateQueries({ queryKey: ["model-configs"] });
      queryClient.invalidateQueries({ queryKey: remoteAgentsQueryKey });
      queryClient.invalidateQueries({ queryKey: agentsQueryKey });
      reloadTrackedRemoteSessions();
    };
    socket.on("event", onEvent);
    socket.on("connect", onConnect);
    if (socket.connected) onConnect();
    return () => {
      socket.off("event", onEvent);
      socket.off("connect", onConnect);
    };
  }, [
    applyIncomingMessage,
    setPresence,
    applyDevicePresence,
    setGlobalAlertMessage,
    upsertConversation,
    removeConversation,
    markConversationRead,
    addScheduleActivity,
    setQuickAssistantName,
    updateSessionStatus,
    applySessionListEventToStore,
    applyRemoteSessionListEvent,
    reloadTrackedRemoteSessions,
    queryClient,
    router,
    t,
  ]);
}
