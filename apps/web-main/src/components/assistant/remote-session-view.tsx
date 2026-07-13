"use client";

import type {
  ArtifactPreviewTarget,
  SessionTransport,
} from "@meshbot/web-common/session";
import {
  createSessionSocketAdapter,
  MessageSkeleton,
  SessionConversationView,
  useSessionStream,
} from "@meshbot/web-common/session";
import { PageShellView } from "@meshbot/web-common/shell";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatScroll } from "@/hooks/use-chat-scroll";
import { useRemoteSessions } from "@/hooks/use-remote-sessions";
import { createRemoteSessionTransport } from "@/lib/session-transport";
import { useProfile } from "@/rest/auth";
import { ArtifactPreviewPanel } from "./artifact-preview-panel";
import { RemoteChatInput } from "./remote-chat-input";
import { RemoteModelSelect } from "./remote-model-select";
import { RemoteSubagentCard } from "./remote-subagent-card";

/** 新建远程会话时，等待首帧回报 sessionId 的超时（协议未提供离线时的显式收尾——
 * 见 `packages/web-common/src/session/remote-run-tracker.ts` 的
 * 「create 模式 + 从未收到首帧 + sessionId 未知」分支——超时是唯一能兜住
 * 「目标设备离线/迟迟不响应」的手段）。 */
const CREATE_TIMEOUT_MS = 10_000;

/**
 * 发起一次新远程会话：`transport.startRun({mode:"create"})` 拿到 `streamId` 后，
 * 临时订阅该 transport 实例的帧流，等第一个带 `sessionId` 的事件（几乎总是
 * `run.human`，回报「B 已创建会话 + 记下用户消息」）到达即 resolve。
 *
 * 必须与后续 `useSessionStream` 复用**同一个** transport 实例——它内部的
 * `RemoteRunTracker.register(streamId, ...)` 已经在 `startRun()` 调用时登记，
 * 换一个新 transport 实例会导致后续帧因 `owns(streamId)===false` 被直接丢弃
 * （见 T10 报告「流归属过滤」）。
 *
 * 离线场景：网关判定目标设备离线时只回 `agentRunEnd{reason:"offline"}`，
 * 不会有任何过程帧；`RemoteRunTracker.handleEnd` 在 `sessionId` 未知时返回
 * `null`（协议层面的固有缺口，见 remote-run-tracker.ts 类文档），本函数
 * 因此收不到任何回调，只能靠超时兜底 reject。
 */
function startNewRemoteSession(
  transport: SessionTransport,
  content: string,
): Promise<{ sessionId: string; streamId: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      reject(new Error("timeout"));
    }, CREATE_TIMEOUT_MS);

    transport
      .startRun({ mode: "create", content })
      .then(({ streamId }) => {
        if (!streamId) {
          // 契约上 create 模式恒返回非空 streamId（web-main 远程工厂实现），
          // 防御式兜底：视为立即失败，不悬挂等到超时。
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error("no-stream-id"));
          return;
        }
        unsubscribe = transport.subscribe({
          onEvent(_event, payload) {
            if (settled) return;
            const sid = (payload as { sessionId?: string } | undefined)
              ?.sessionId;
            if (!sid) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe?.();
            resolve({ sessionId: sid, streamId });
          },
        });
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

interface RemoteSessionViewProps {
  deviceId: string;
  /** 当前查看的会话 id；null = 尚未选中/新建（展示创建态输入框）。 */
  sessionId: string | null;
  /** 首轮由本组件自己发起 create 时，用它初始化 `useSessionStream` 的
   * `remoteInitialStreamId`（乐观 running=true + 中断可路由）；直接导航进
   * 已有会话（如从 SessionSublist 点击）时为 null——刷新丢流是已知 V1 边界
   * （见 T10 报告 concern 1），`useSessionStream` 内部已把 `fetchActiveRun`
   * 的失败静默吞掉，本组件不做任何额外的 reclaim 尝试。 */
  streamId: string | null;
  /** 当前组织 id（模型选择器用）。 */
  orgId: string;
  /** 新建会话解析出 sessionId 后回调（调用方负责把它同步进 URL）。 */
  onSessionCreated: (sessionId: string, streamId: string) => void;
}

/**
 * 设备远程会话主视图（web-main）：拥有 transport 生命周期的外层壳。
 *
 * `createRemoteSessionTransport()` 会立即注册三个 socket 监听器（真实副作用），
 * 不能放渲染期的 `useMemo`/`useState` 惰性初始化器里构建——两者在 Strict Mode
 * 下都会被「调用两次、只留一份」，被丢弃的那份监听器永远等不到 dispose，在
 * module 级单例 socket（`getImSocket()`）上无界累积（一期 `messages-view.tsx`
 * 同款问题的修复先例）。改为在 `useEffect` 里构建，`useState` 持有；effect 的
 * 清理函数里显式 `dispose()`——与 `useMemo`/`useState` 初始化器不同，
 * `useEffect` 的清理在 Strict Mode 的「挂载→卸载→再挂载」之间真实触发一次，
 * 不会漏掉丢弃的那份。
 *
 * 代价：挂载首帧到 effect 建成之间存在一个 `transport` 为 `null` 的短暂窗口。
 * 不能在这个窗口内调用下方 {@link RemoteSessionViewReady} 里那些依赖 transport
 * 的 hook（`useSessionStream`/`useRemoteSessions` 等）——按 React hooks 规则，
 * 同一组件实例的两次渲染必须调用同样数量/顺序的 hook，不能等 `transport` 就绪
 * 后再多调用一批 hook。因此把「依赖 transport 的一切」（含
 * `renderSubagentCard` 闭包对 transport 的引用）整体下沉到只在 transport
 * 就绪后才挂载的子组件，未就绪时只渲染 `MessageSkeleton` 占位（复用
 * `SessionConversationView` 历史加载态的同一块骨架），不渲染会话区。
 */
export function RemoteSessionView(props: RemoteSessionViewProps) {
  const { deviceId } = props;
  const scrollRef = useRef<HTMLDivElement>(null);

  const [transport, setTransport] = useState<SessionTransport | null>(null);
  useEffect(() => {
    const created = createRemoteSessionTransport(deviceId);
    setTransport(created);
    // 三个监听器挂在 module 级单例 socket 上，deviceId 切换/组件卸载都要
    // 显式 dispose，否则无界累积（同 transport.dispose() 既有惯例）。
    return () => {
      created.dispose?.();
    };
  }, [deviceId]);

  if (!transport) {
    return (
      <PageShellView scrollContainerRef={scrollRef}>
        <MessageSkeleton />
      </PageShellView>
    );
  }

  return <RemoteSessionViewReady {...props} transport={transport} />;
}

/**
 * transport 就绪后才挂载：`useSessionStream`（web-common）+ remote-only
 * transport + `SessionSocketLike` 适配器 + `SessionConversationView` 装配，
 * 镜像 `apps/web-agent/src/components/session/assistant-conversation-body.tsx`
 * 的角色。
 *
 * `sessionId` 为 null 时渲染「新建会话」态（仅输入框，无历史/无工具流）；
 * 首次发送经 {@link startNewRemoteSession} 解析出 sessionId 后回调
 * `onSessionCreated`——调用方（页面）据此把 `?session=` 写进 URL，本组件
 * 自身不做导航，只暴露状态转移。
 */
function RemoteSessionViewReady({
  deviceId,
  sessionId,
  streamId,
  orgId,
  onSessionCreated,
  transport,
}: RemoteSessionViewProps & { transport: SessionTransport }) {
  const t = useTranslations("session");
  const tAssistant = useTranslations("assistant");
  const scrollRef = useRef<HTMLDivElement>(null);
  const profile = useProfile();
  const userName =
    profile.data?.user?.displayName ??
    profile.data?.user?.email ??
    t("youName");

  const socketAdapter = useMemo(
    () => createSessionSocketAdapter(transport),
    [transport],
  );
  const getSocket = useCallback(() => socketAdapter, [socketAdapter]);

  const stream = useSessionStream(
    sessionId,
    scrollRef,
    transport,
    getSocket,
    {},
    deviceId,
    streamId,
  );

  const { data: sessions } = useRemoteSessions(deviceId, transport, true);
  const currentSession = sessions?.find((s) => s.id === sessionId);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const sessionModelId = modelOverride ?? currentSession?.modelConfigId ?? null;

  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<
    | (ArtifactPreviewTarget & {
        remote: { deviceId: string; sessionId: string };
      })
    | null
  >(null);

  const timelineMessages = useMemo(
    () => stream.messages.filter((m) => !m.pending),
    [stream.messages],
  );
  const queuedMessages = useMemo(
    () => stream.messages.filter((m) => m.pending),
    [stream.messages],
  );

  const { stickToBottom, scrollToBottom, topSentinelRef } = useChatScroll({
    scrollContainerRef: scrollRef,
    messages: timelineMessages,
    hasMore: stream.hasMoreHistory,
    onLoadMore: () => void stream.loadMoreHistory(),
  });

  const handleModelChange = async (modelConfigId: string) => {
    if (!sessionId) {
      setModelOverride(modelConfigId);
      return;
    }
    try {
      await stream.patchSessionModel(modelConfigId);
      setModelOverride(modelConfigId);
    } catch (err) {
      console.error("切换模型失败", err);
      setActionError(t("actionFailed"));
    }
  };

  const handleSend = async (text: string) => {
    setActionError(null);
    if (!sessionId) {
      setCreating(true);
      try {
        const created = await startNewRemoteSession(transport, text);
        setDraft("");
        onSessionCreated(created.sessionId, created.streamId);
      } catch {
        setActionError(t("createFailed"));
      } finally {
        setCreating(false);
      }
      return;
    }
    setDraft("");
    await stream.send(text);
  };

  const guardedConfirm = useCallback(
    async (
      toolCallId: string,
      decision: "send" | "cancel",
      content?: string,
    ) => {
      try {
        await stream.confirm(toolCallId, decision, content);
      } catch (err) {
        console.error("确认操作失败", err);
        setActionError(t("actionFailed"));
      }
    },
    [stream, t],
  );

  const guardedAnswer = useCallback(
    async (
      toolCallId: string,
      answers: { selected: string[]; other?: string }[],
    ) => {
      try {
        await stream.answer(toolCallId, answers);
      } catch (err) {
        console.error("提交回答失败", err);
        setActionError(t("actionFailed"));
      }
    },
    [stream, t],
  );

  const artifactRemote = sessionId ? { deviceId, sessionId } : null;

  /** present_file 卡片点击预览：`target.remote` 恒非空（web-main 只有远程会话，
   * `ArtifactFileCard`/`ToolCallBlock` 已按 `artifactRemote` prop 原样带上），
   * 缺失视为异常数据、静默丢弃。 */
  const handlePreviewArtifact = useCallback((target: ArtifactPreviewTarget) => {
    if (!target.remote) return;
    setPreview(
      target as ArtifactPreviewTarget & {
        remote: { deviceId: string; sessionId: string };
      },
    );
  }, []);

  const errorBanner = actionError && (
    <div className="mx-4 mt-2 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
      <span>{actionError}</span>
      <button
        type="button"
        onClick={() => setActionError(null)}
        className="shrink-0 text-destructive/70 hover:text-destructive"
      >
        {t("dismiss")}
      </button>
    </div>
  );

  if (!sessionId) {
    return (
      <PageShellView scrollContainerRef={scrollRef}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--shell-accent)/12 text-(--shell-accent)">
            <Sparkles className="h-7 w-7" />
          </span>
          <div className="text-[15px] font-semibold text-foreground">
            {tAssistant("newSessionTitle")}
          </div>
          <div className="max-w-[320px] text-[13px] text-muted-foreground">
            {tAssistant("newSessionHint")}
          </div>
        </div>
        {errorBanner}
        <div className="sticky bottom-4 mt-auto w-full bg-background">
          <RemoteChatInput
            value={draft}
            onChange={setDraft}
            onSend={(text) => void handleSend(text)}
            isLoading={creating}
            disabled={creating}
            placeholder={t("input.placeholder")}
            trailingActions={
              <RemoteModelSelect
                orgId={orgId}
                value={modelOverride}
                onChange={(mid) => void handleModelChange(mid)}
              />
            }
            labels={{ send: t("input.send"), stop: t("input.stop") }}
          />
        </div>
      </PageShellView>
    );
  }

  return (
    <>
      <PageShellView
        scrollContainerRef={scrollRef}
        header={
          <div className="shrink-0 bg-(--shell-content)">
            <div className="flex h-13 w-full items-center gap-2 border-b border-border px-4 lg:px-6">
              <Sparkles className="h-4 w-4 shrink-0 text-(--shell-accent)" />
              <span className="truncate text-[15px] font-semibold text-foreground">
                {currentSession?.title ?? tAssistant("remoteSessionTitle")}
              </span>
            </div>
          </div>
        }
      >
        {errorBanner}
        <SessionConversationView
          historyLoading={stream.historyLoading}
          historyError={stream.historyError}
          hasMoreHistory={stream.hasMoreHistory}
          topSentinelRef={topSentinelRef}
          compacting={stream.compacting}
          timelineMessages={timelineMessages}
          queuedMessages={queuedMessages}
          sessionId={sessionId}
          running={stream.running}
          readOnly
          onRegenerateOptimisticCut={() => {}}
          onConfirm={guardedConfirm}
          onAnswer={guardedAnswer}
          userName={userName}
          assistantName={t("assistantName")}
          resolveImTargetName={(conversationId) => conversationId ?? ""}
          onPreviewArtifact={handlePreviewArtifact}
          artifactRemote={artifactRemote}
          renderSubagentCard={(subTool) => (
            <RemoteSubagentCard
              tool={subTool}
              deviceId={deviceId}
              transport={transport}
              streamId={stream.getStreamId()}
              onPreviewArtifact={handlePreviewArtifact}
            />
          )}
          stickToBottom={stickToBottom}
          onScrollToBottom={scrollToBottom}
          renderInput={() => (
            <RemoteChatInput
              value={draft}
              onChange={setDraft}
              onSend={(text) => void handleSend(text)}
              onInterrupt={stream.interrupt}
              isLoading={stream.running}
              placeholder={t("input.placeholder")}
              trailingActions={
                <RemoteModelSelect
                  orgId={orgId}
                  value={sessionModelId}
                  onChange={(mid) => void handleModelChange(mid)}
                />
              }
              labels={{ send: t("input.send"), stop: t("input.stop") }}
            />
          )}
          labels={{
            scrollToBottom: t("scrollToBottom"),
            remoteLoadFailed: t("remoteLoadFailed"),
            compaction: {
              bannerThreshold: t("compaction.bannerThreshold"),
              bannerCtxExceeded: t("compaction.bannerCtxExceeded"),
            },
            messageList: {
              assistantName: t("assistantName"),
              runErrorPrefix: t("runErrorPrefix"),
              generatingReply: t("generatingReply"),
              reasoningThinking: (seconds) =>
                t("reasoningThinking", { seconds }),
              reasoningThought: (seconds) => t("reasoningThought", { seconds }),
              reasoningProcess: t("reasoningProcess"),
              compactionRowTitle: (count) =>
                t("compaction.rowTitle", { count }),
            },
            toolCall: { artifactPresentFailed: t("artifact.presentFailed") },
            pendingList: {
              editPending: t("editPending"),
              deletePending: t("deletePending"),
            },
          }}
        />
      </PageShellView>
      <ArtifactPreviewPanel target={preview} onClose={() => setPreview(null)} />
    </>
  );
}
