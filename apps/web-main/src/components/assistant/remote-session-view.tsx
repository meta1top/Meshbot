"use client";

import type {
  ArtifactPreviewTarget,
  SessionTransport,
} from "@meshbot/web-common/session";
import {
  ArtifactSplitPane,
  ChatInput,
  createSessionSocketAdapter,
  MessageSkeleton,
  SessionConversationView,
  useSessionStream,
} from "@meshbot/web-common/session";
import { PageShellView, ResizableSheet } from "@meshbot/web-common/shell";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatScroll } from "@/hooks/use-chat-scroll";
import {
  remoteSessionsQueryKey,
  useRemoteSessions,
} from "@/hooks/use-remote-sessions";
import { useStoredWidth } from "@/hooks/use-stored-width";
import { takeLauncherDraft } from "@/lib/launcher-draft";
import {
  createRemoteSessionTransport,
  WATCH_ACCEPTED_EVENT,
  WATCH_REJECTED_EVENT,
  type WatchAcceptedEvent,
  type WatchRejectedEvent,
} from "@/lib/session-transport";
import { useProfile } from "@/rest/auth";
import { ComposerActions } from "./composer-actions";
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
  /** 目标云端 Agent id（计划二 2b · T7：寻址主键，用于 transport 创建 /
   * 远程会话列表查询 / 会话创建后失效缓存——不是设备 id）。 */
  agentId: string;
  /** Agent 的宿主设备 id：本组件不用它寻址，仅原样透传给
   * `artifactRemote`/`RemoteSubagentCard`/`RemoteMessageList` 等纯展示/
   * 流归属标记用途（`useSessionStream` 的 `remoteDeviceId` 形参只当
   * 「是否 remote 分支」的布尔标记，不参与寻址，详见该 hook 类文档）。 */
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
  /** 启动台交接来的一次性草稿 token；挂载后取回并自动发送（新建会话首轮）。 */
  draftToken?: string | null;
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
  const { agentId } = props;
  const scrollRef = useRef<HTMLDivElement>(null);

  const [transport, setTransport] = useState<SessionTransport | null>(null);
  useEffect(() => {
    const created = createRemoteSessionTransport(agentId);
    setTransport(created);
    // 三个监听器挂在 module 级单例 socket 上，agentId 切换/组件卸载都要
    // 显式 dispose，否则无界累积（同 transport.dispose() 既有惯例）。
    return () => {
      created.dispose?.();
    };
  }, [agentId]);

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
  agentId,
  deviceId,
  sessionId,
  streamId,
  orgId,
  draftToken,
  onSessionCreated,
  transport,
}: RemoteSessionViewProps & { transport: SessionTransport }) {
  const t = useTranslations("session");
  const tAssistant = useTranslations("assistant");
  const tArtifact = useTranslations("session.artifact");
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

  const queryClient = useQueryClient();
  const stream = useSessionStream(
    sessionId,
    scrollRef,
    transport,
    getSocket,
    {
      // B 端异步生成会话标题 → 失效侧栏会话列表，标题即时刷新
      // （新建会话时列表里先是空标题，标题一到就补上）。
      onTitleUpdated: () => {
        void queryClient.invalidateQueries({
          queryKey: remoteSessionsQueryKey(agentId),
        });
      },
    },
    agentId,
    streamId,
  );

  // 观察通道被拒（设备离线 / Agent 不可远程 / 会话不归它）的可见反馈——
  // `session-transport.ts` 的 `onWatchAccepted` 在 `ok:false` 时合成
  // `WATCH_REJECTED_EVENT` 交给 `subscribe()`，不能只 console.warn 静默
  // （上一轮 review 明确要求）。只认当前 sessionId 的拒绝（换会话后旧会话
  // 迟到的拒绝回执不应污染新会话的横幅）。
  const [watchNotice, setWatchNotice] = useState<WatchRejectedEvent | null>(
    null,
  );

  // Session 级观察通道（spec D5「打开会话即 session-watch」）：进入会话即
  // `transport.watchSession(sessionId)`，卸载/切会话时调用返回的 unwatch——
  // 否则设备侧常驻转发器要等满 5 分钟 idle 才拆（能兜住，但白占资源）。
  // `transport.watchSession` 内部已处理断线重连自动重 watch（T12
  // `onReconnect`），本组件不需要感知 socket 连接状态。
  useEffect(() => {
    setWatchNotice(null); // 换会话/换 transport 先清掉上一轮的拒绝提示
    if (!sessionId) return;
    const unwatch = transport.watchSession?.(sessionId);
    return () => unwatch?.();
  }, [transport, sessionId]);

  useEffect(() => {
    const unsubscribe = transport.subscribe({
      onEvent(event, payload) {
        if (event === WATCH_REJECTED_EVENT) {
          const rejected = payload as WatchRejectedEvent;
          if (rejected.sessionId !== sessionId) return;
          setWatchNotice(rejected);
          return;
        }
        if (event === WATCH_ACCEPTED_EVENT) {
          // 重 watch 成功后撤下此前可能挂着的旧横幅（T12 review Finding 7）：
          // idle 回收之外的拒绝不会自动重连，但 socket 重连、或用户重新
          // 打开设备后云端换发新 watchId 重新受理时，旧横幅不该继续挂着，
          // 否则用户会以为仍然收不到实时帧。
          const accepted = payload as WatchAcceptedEvent;
          if (accepted.sessionId !== sessionId) return;
          setWatchNotice(null);
        }
      },
    });
    return unsubscribe;
  }, [transport, sessionId]);

  const { data: sessions } = useRemoteSessions(agentId, true);
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
  const [previewWidth, setPreviewWidth] = useStoredWidth(
    "meshbot.artifactPanelWidth",
  );
  // 上传网盘成功提示：web-main 无网盘 presigned URL 前端基础设施，不像 web-agent
  // 那样能上传后自动切换预览源（见 Task 3 报告「大文件网盘路径复用」两种取舍），
  // 简化为面板内一条可关闭的成功提示；切换/关闭预览目标时清空（下方 effect）。
  const [uploadNotice, setUploadNotice] = useState<{ name: string } | null>(
    null,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: preview 是「切换预览目标」触发器，切目标/关闭都要清旧上传提示
  useEffect(() => {
    setUploadNotice(null);
  }, [preview]);

  // ESC 关产物面板（对齐旧弹窗 `artifact-preview-panel.tsx` 的既有行为）。
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

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
    // send() 返回 false = 本条输入被拒绝且没有任何留痕（当前唯一来源：该会话
    // 仍有 run 在跑的 I3 守卫）。ChatInput 的 onSend 是无条件清空编辑器的，
    // 不回填 + 不提示的话用户打的字就凭空消失了（原 bug）。
    const accepted = await stream.send(text);
    if (!accepted) {
      setDraft(text);
      setActionError(t("sendWhileRunning"));
    }
  };

  // 启动台草稿：挂载后取回（读即删）并自动发起首轮 create。
  // - 必须在 effect 里取，不能放渲染期——takeLauncherDraft 有「读即删」副作用；
  // - draftSentRef 守卫确保只发一次（StrictMode 双挂载 / 重渲染都不重复发送）；
  // - handleSend 走 ref 取当次最新实现，从而不必进依赖数组（进了会随每次渲染重跑）。
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  const draftSentRef = useRef(false);
  useEffect(() => {
    if (draftSentRef.current || !draftToken || sessionId) return;
    const text = takeLauncherDraft(draftToken);
    if (!text) return;
    draftSentRef.current = true;
    void handleSendRef.current(text);
  }, [draftToken, sessionId]);

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

  /** watch 被拒的 reason → 文案（`session-transport.ts` 的 `WATCH_REJECTED_EVENT`，
   * reason 原样透传自 `AgentWatchAccepted`）。 */
  const watchRejectedReasonText = (
    reason: WatchRejectedEvent["reason"],
  ): string => {
    switch (reason) {
      case "offline":
        return t("watchRejectedOffline");
      case "not_found":
        return t("watchRejectedNotFound");
      case "session_agent_mismatch":
        return t("watchRejectedSessionAgentMismatch");
      case "cross_account":
        return t("watchRejectedCrossAccount");
      case "error":
        return t("watchRejectedError");
      default:
        return t("watchRejectedUnknown");
    }
  };

  /** 观察通道被拒的可见提示——警示色（非 destructive）：会话历史仍可正常看，
   * 只是收不到「实时」帧，语义上是降级而非失败。可关闭，换会话会自动清空
   * （见上方 effect）。 */
  const watchNoticeBanner = watchNotice && (
    <div className="mx-4 mt-2 flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-400">
      <span>
        {t("watchRejectedPrefix")}
        {watchRejectedReasonText(watchNotice.reason)}
      </span>
      <button
        type="button"
        onClick={() => setWatchNotice(null)}
        className="shrink-0 text-amber-700/70 hover:text-amber-700 dark:text-amber-400/70"
      >
        {t("dismiss")}
      </button>
    </div>
  );

  /**
   * 产物右侧滑入面板（对齐 web-agent `(shell)/layout.tsx` 的 `ArtifactSplitPane`
   * aside 挂法，删掉的旧版是居中弹窗 `artifact-preview-panel.tsx`）：条件挂载
   * （非常驻 + `absolute` 覆盖，不参与 flex 布局），落在 `(shell)/layout.tsx`
   * 已有的 `relative overflow-hidden` 容器内（`AssistantLayout`/`AssistantSidebar`
   * 均是透传 Fragment/Context.Provider，不产生额外 DOM 节点，本组件的输出直接是
   * 该容器的 DOM 子节点）——web-main 无 Electron，不需要 web-agent 那套
   * `titleBarClassName`/`actionButtonClassName` 拖拽区类名注入。
   *
   * `transport` 直接复用本组件已持有的同一 `SessionTransport` 实例（Task 3 报告
   * 「数据注入形态」：其 `readArtifact`/`uploadArtifactToDrive` 与共享
   * `ArtifactRemoteTransport` 结构类型一致），不像旧弹窗那样为每次预览另起一个
   * transport 实例（省一份三监听器 + dispose 生命周期管理）。
   *
   * `renderPdf` 不传：web-main 无 react-pdf 依赖，退化为 `ArtifactBody` 内置的
   * 原生 `<iframe>` PDF 查看器，与旧弹窗行为一致（本期不做 PDF 专属渲染）。
   *
   * `onUploadedToDrive`：web-main 无网盘 presigned URL REST 客户端，不像
   * web-agent 那样自动切换预览源，退化为面板内提示成功（`uploadNotice`
   * state，沿用旧弹窗 `uploadSuccess` 文案）——Task 3 报告已记录两种取舍均可。
   *
   * 壳与拖拽调宽复用 web-common 的 `ResizableSheet`（与 web-agent 随手问/产物预览
   * 同一份实现）：默认 50% 窗宽、下限 480px，拖过之后按 px 记住。
   */
  const previewAside = preview && (
    <ResizableSheet
      width={previewWidth}
      onWidthChange={setPreviewWidth}
      defaultWidth="50vw"
      className="animate-in fade-in slide-in-from-right-4"
    >
      {uploadNotice && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-emerald-600/10 px-3 py-2 text-[12px] text-emerald-700 dark:text-emerald-400">
          <span className="min-w-0 flex-1 truncate">
            {tArtifact("uploadSuccess", { name: uploadNotice.name })}
          </span>
          <button
            type="button"
            onClick={() => setUploadNotice(null)}
            className="shrink-0 text-emerald-700/70 hover:text-emerald-700 dark:text-emerald-400/70"
          >
            ×
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ArtifactSplitPane
          target={preview}
          onClose={() => setPreview(null)}
          labels={{
            empty: tArtifact("empty"),
            untitled: tArtifact("untitled"),
            download: tArtifact("download"),
            close: tArtifact("close"),
            body: {
              loading: tArtifact("loading"),
              loadFailed: tArtifact("loadFailed"),
              unsupported: tArtifact("unsupported"),
              tooLarge: (sizeMb: string) =>
                tArtifact("tooLarge", { size: sizeMb }),
              tooLargeHint: tArtifact("tooLargeHint"),
              uploadFailed: tArtifact("uploadFailed"),
              uploading: tArtifact("uploading"),
              uploadToDrive: tArtifact("uploadToDrive"),
              previewTitle: tArtifact("previewTitle"),
              imageAlt: tArtifact("imageAlt"),
            },
          }}
          transport={transport}
          onUploadedToDrive={(up) => {
            setUploadNotice({ name: up.name });
          }}
        />
      </div>
    </ResizableSheet>
  );

  if (!sessionId) {
    return (
      <>
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
          {watchNoticeBanner}
          <div className="sticky bottom-4 mt-auto w-full bg-background">
            {/* Task 1 抽出的完整 ChatInput（web-agent 同款）。leadingActions
                （技能/连应用/权限）是共享的占位动作链，云端与本地端 composer 一致；
                tokenUsage 不传，退化为无用量环的简版（web-common 的
                `useSessionStream` 用量走回调而非返回值，remote 侧未接线，
                见类文档 `UseSessionStreamCallbacks`）。 */}
            <ChatInput
              value={draft}
              onChange={setDraft}
              onSend={(text) => void handleSend(text)}
              isLoading={creating}
              placeholder={t("input.placeholder")}
              leadingActions={<ComposerActions />}
              trailingActions={
                <RemoteModelSelect
                  orgId={orgId}
                  value={modelOverride}
                  onChange={(mid) => void handleModelChange(mid)}
                />
              }
              labels={{
                attachment: t("input.attachment"),
                interrupt: t("input.stop"),
              }}
            />
          </div>
        </PageShellView>
        {previewAside}
      </>
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
        {watchNoticeBanner}
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
            <ChatInput
              value={draft}
              onChange={setDraft}
              onSend={(text) => void handleSend(text)}
              onInterrupt={stream.interrupt}
              isLoading={stream.running}
              canInterrupt={stream.canInterrupt}
              placeholder={t("input.placeholder")}
              leadingActions={<ComposerActions />}
              trailingActions={
                <RemoteModelSelect
                  orgId={orgId}
                  value={sessionModelId}
                  onChange={(mid) => void handleModelChange(mid)}
                />
              }
              labels={{
                attachment: t("input.attachment"),
                interrupt: t("input.stop"),
                interruptUnavailable: t("input.stopUnavailable"),
              }}
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
              runErrorAgentNotRemotable: t("runErrorAgentNotRemotable"),
              runErrorSessionAgentMismatch: t("runErrorSessionAgentMismatch"),
              runErrorOffline: t("runErrorOffline"),
            },
            toolCall: {
              artifactPresentFailed: t("artifact.presentFailed"),
              hitlSettledElsewhere: t("hitlSettledElsewhere"),
            },
            pendingList: {
              editPending: t("editPending"),
              deletePending: t("deletePending"),
            },
          }}
        />
      </PageShellView>
      {previewAside}
    </>
  );
}
