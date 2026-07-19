"use client";

import {
  type HistoryMessage,
  type InflightToolCall,
  type MessageUsage,
  type RunChunkEvent,
  type RunDoneEvent,
  type RunErrorEvent,
  type RunHumanEvent,
  type RunInterruptedEvent,
  type RunReasoningChunkEvent,
  type RunReasoningDoneEvent,
  type RunSnapshotEvent,
  type RunSubagentSettledEvent,
  type RunSubagentSpawnedEvent,
  type RunToolCallArgsDeltaEvent,
  type RunToolCallEndEvent,
  type RunToolCallProgressEvent,
  type RunToolCallStartEvent,
  type RunUsageEvent,
  SESSION_WS_EVENTS,
  type SessionTitleUpdatedEvent,
  type SessionUsage,
} from "@meshbot/types-agent";
import { useCallback, useEffect, useRef, useState } from "react";
import { clientSnowflakeId } from "../utils/snowflake";
import type { SessionSocketLike } from "./socket-like";
import {
  claimSubagentOnTimeline,
  settleSubagentOnTimeline,
} from "./subagent-card";
import type { TimelineMessage } from "./timeline";
import type { SessionTransport } from "./transport";

/**
 * history 单条消息 → TimelineMessage 映射：本地 REST 与跨设备（L3 device
 * query）、首屏拉取与 loadMoreHistory 翻页，四条路径共用同一份（曾经翻页只
 * 映射 id/role/content/reasoning，丢了 toolCalls——含 dispatch_subagent 嵌套卡
 * 认领用的 subSessionId——与 feedback，导致上翻加载出来的历史消息里工具卡/
 * 嵌套卡/反馈态全部消失）。
 *
 * 远程分支曾另有一份「防御式」映射（`remoteMessageToTimeline`）：B 侧当时直出
 * 裸 ORM 行，前端只能自己解析 JSON 字符串、过滤 role="tool"、并把工具状态硬编码
 * 成 "ok"（失败的工具于是在远端显示成成功、结果区永远空、subSessionId 丢失）。
 * B 侧 `RemoteQueryInboundService` 现已与 REST 共用 `assembleHistoryMessages`
 * 装配出真正的 `HistoryResponse`，那份补救随之删除，remote 与 local 收敛到这里。
 */
function historyMessageToTimeline(m: HistoryMessage): TimelineMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    // 持久化的 reasoning 直接带入；设了 durationMs=0 让 UI 显示「已思考」
    // 不显示动态秒数（实际生成时长信息没存）。reasoningStartedAt 不设。
    ...(m.reasoning ? { reasoning: m.reasoning, reasoningDurationMs: 0 } : {}),
    // 持久化的 tool calls：转 ToolCallView；progress 留空（流式过程没存）
    // Array.isArray 守卫：跨设备场景对端设备可能是尚未升级的旧版 server-agent，
    // 那种版本直出裸 ORM 行、toolCalls 是 JSON **字符串**——不守卫会在 .map 处
    // 抛 TypeError 把整屏历史打没（宁可少渲染工具卡，也不能整页崩）。
    ...(Array.isArray(m.toolCalls) && m.toolCalls.length > 0
      ? {
          toolCalls: m.toolCalls.map((tc) => ({
            toolCallId: tc.toolCallId,
            name: tc.name,
            args: tc.args,
            status: tc.status,
            result: tc.result,
            ...(tc.subSessionId ? { subSessionId: tc.subSessionId } : {}),
          })),
        }
      : {}),
    feedback: m.feedback ?? null,
  };
}

/**
 * 把 inflight 快照里的 tool_call args 前缀合并进消息的工具块。
 *
 * 中途订阅（刷新 / 切回会话 / 云端发起本地打开）时，args 的前半段已经流过去了，
 * 只靠后续 delta 拼出来的是 JSON 尾巴片段（解析不出 → 工具卡空转到 tool_call_start
 * 才整包补齐）。快照补上前缀后，后续 delta 继续 append 就能连成完整流。
 *
 * 只补 streaming 态的块：已经 running/终态的块有权威 args 与结果，快照是「补历史」，
 * 不能把已推进的状态回退。
 */
function mergeInflightToolCalls(
  existing: TimelineMessage["toolCalls"],
  snapshot: readonly InflightToolCall[],
): TimelineMessage["toolCalls"] {
  if (snapshot.length === 0) return existing;
  const list = existing ? [...existing] : [];
  for (const tc of snapshot) {
    const i = list.findIndex((t) => t.toolCallId === tc.toolCallId);
    if (i === -1) {
      list.push({
        toolCallId: tc.toolCallId,
        name: tc.name,
        status: "streaming",
        argsText: tc.argsText,
      });
      continue;
    }
    if (list[i].status !== "streaming") continue;
    list[i] = {
      ...list[i],
      name: tc.name || list[i].name,
      argsText: tc.argsText, // SET 覆盖：快照是本轮 args 的全量前缀，不累加
    };
  }
  return list;
}

/**
 * `useSessionStream` 的 usage / 标题写入回调（原 web-agent jotai atoms 写入点
 * 迁出后的回调化形态）。每个回调对应原代码里唯一一处 atom 写入调用，1:1
 * 映射，供调用方（web-agent 薄桥）逐个接回 atoms；web-main 等消费方可选择性
 * 忽略不需要的回调（如无用量展示需求）。
 */
export interface UseSessionStreamCallbacks {
  /**
   * 进入会话时重置用量累计（原 `resetUsageAtom`）。每次 sessionId 变化的
   * effect 开头调用一次，先于任何历史/socket 数据到达。
   */
  onUsageReset?: (sessionId: string) => void;
  /**
   * 用 history 接口返回的整包 usage 初始化（原 `setInitialUsageAtom`）。
   * 仅 local 分支、且 history 携带 sessionTotals 时调用。
   */
  onUsageInitial?: (sessionId: string, usage: SessionUsage) => void;
  /**
   * socket run.usage 单条事件到达时累加（原 `appendUsageAtom`）。
   */
  onUsageEvent?: (sessionId: string, event: RunUsageEvent) => void;
  /**
   * 批量合并一批 byMessage 用量（原 `appendUsageByMessageAtom`）：local 首屏
   * 历史无 sessionTotals 时的防御分支，以及 `loadMoreHistory` 翻页后追加。
   */
  onUsageBatch?: (
    sessionId: string,
    batch: Record<string, MessageUsage>,
  ) => void;
  /**
   * 会话标题后台生成完成（原 `updateSessionTitleAtom`）：全局广播事件，不限
   * 当前 sessionId（原实现里 `onTitleUpdated` 就不做 sessionId 匹配过滤）。
   */
  onTitleUpdated?: (sessionId: string, title: string) => void;
}

export interface SessionStream {
  /** 全部消息（含 pending 队列）。 */
  messages: TimelineMessage[];
  /** 是否有 run 在跑。 */
  running: boolean;
  /** 压缩进行中：null=未压缩；reason 字符串=压缩中。 */
  compacting: null | "threshold" | "ctx-exceeded";
  /** 还有更早历史可上拉。 */
  hasMoreHistory: boolean;
  /** 首屏历史加载中（用于显示骨架）。 */
  historyLoading: boolean;
  /** 首屏历史加载失败（目前仅 remote 分支会置位——跨设备 relay 更易超时/离线；
   * 本地分支沿用历史行为，失败只 console.error，不置位）。 */
  historyError: boolean;
  /** 单一消息写入口（同步 ref+state），供视图做局部变更（pending 删/改、重生成截断）。 */
  apply: (next: (prev: TimelineMessage[]) => TimelineMessage[]) => void;
  /**
   * 发送一条消息：本地乐观插 pending user 气泡 + append；remote 走远程 run 隧道。
   *
   * 返回 `false` 表示**本条输入被拒绝、没有任何留痕**（当前唯一来源：remote
   * 分支 `running=true` 的 I3 守卫）——调用方**必须**据此给用户可见反馈并把
   * 文本回填输入框：`ChatInput.onSend` 是无条件清空编辑器的，静默 return 会
   * 让用户打的字凭空消失且零提示（原 bug）。返回 `true` 表示已受理（含
   * 「发起失败但已补一条 failed 气泡」的情形——那已经是可见反馈了）。
   */
  send: (msg: string) => Promise<boolean>;
  /** 中断当前 run：本地经 WS，remote 经 relay 控制帧。 */
  interrupt: () => void;
  /** 上拉加载更早历史（含滚动锚定，需传 scrollContainerRef）。local/remote 均支持。 */
  loadMoreHistory: () => Promise<void>;
  /** 本地会话为 null；远程会话为目标设备 id，供 RemoteSessionProvider 使用。 */
  remoteDeviceId: string | null;
  /** 读取当前有效的 streamId（remote 分支才有意义），供确认/作答卡片点击时取「实时」值，而非渲染时的闭包快照。 */
  getStreamId: () => string | null;
  /** 确认/取消一次待发送的工具调用（im_send_message 等 confirm 型 HITL）；streamId 由内部按 remote/local 现取。 */
  confirm: (
    toolCallId: string,
    decision: "send" | "cancel",
    content?: string,
  ) => Promise<void>;
  /** 提交 ask_question 型 HITL 的回答。 */
  answer: (
    toolCallId: string,
    answers: { selected: string[]; other?: string }[],
  ) => Promise<void>;
  /** 切换会话绑定模型（下一条消息生效）。 */
  patchSessionModel: (modelConfigId: string) => Promise<void>;
}

/**
 * 把所有未终态（streaming/running）的工具块置为 error 终态。
 * 中断/失败后 tool_call_end 永远不会到达，不收尾这些块会永久转圈。
 *
 * 模块级纯函数（原内嵌在 hook 的订阅 effect 闭包里）：提到外面既能被
 * `settleInterruptedTimeline` 复用，也能脱离 React 直接单测。
 */
function settleUnfinishedToolCalls(list: TimelineMessage[]): TimelineMessage[] {
  return list.map((m) =>
    m.toolCalls?.some((t) => t.status === "streaming" || t.status === "running")
      ? {
          ...m,
          toolCalls: m.toolCalls.map((t) =>
            t.status === "streaming" || t.status === "running"
              ? { ...t, status: "error" as const, argsText: undefined }
              : t,
          ),
        }
      : m,
  );
}

/**
 * 结算「被中断/被拒绝」的时间线快照（Bug #4 命门）：清 streaming 标记、
 * 锁定尚未结束的 reasoning 计时（`reasoningDurationMs = now - reasoningStartedAt`）、
 * 把未终态工具块收尾为 error。
 *
 * 点「打断」与后端 `run.interrupted` 事件共用同一份结算逻辑，天然幂等——
 * 字段已经锁定的消息不会被二次覆盖，所以：
 * - 乐观本地打断（`interrupt()` 点击当帧调用，不传 `targetMessageId`）：
 *   立即让「思考中 Xs」计时器停摆、打断按钮消失，不等 WS 往返。
 * - 后端确认到达（`onInterrupted`，传 `e.messageId`）：按原语义只清该条消息的
 *   `streaming`，但这次补充锁 reasoning 计时——这正是原 bug 所在：`onInterrupted`
 *   只清了 `streaming`，从未锁过 `reasoningDurationMs`，导致 `ReasoningBlock`
 *   的 `isThinking`（`durationMs === undefined && startedAt !== undefined`）
 *   哪怕 run 已经结束仍判 true，计时器永远不停。
 *
 * `targetMessageId` 省略时对任意仍在 streaming 的消息生效（单会话同时只有
 * 一条消息在跑，乐观路径不知道具体 messageId 也能正确结算）。
 */
export function settleInterruptedTimeline(
  messages: TimelineMessage[],
  targetMessageId?: string,
): TimelineMessage[] {
  const now = Date.now();
  const settled = messages.map((m) => {
    const clearStreaming =
      m.streaming === true &&
      (targetMessageId === undefined || m.id === targetMessageId);
    const lockDuration =
      m.reasoningStartedAt !== undefined && m.reasoningDurationMs === undefined;
    if (!clearStreaming && !lockDuration) return m;
    return {
      ...m,
      ...(clearStreaming ? { streaming: false } : {}),
      ...(lockDuration
        ? { reasoningDurationMs: now - (m.reasoningStartedAt as number) }
        : {}),
    };
  });
  return settleUnfinishedToolCalls(settled);
}

/**
 * `run.error` 事件的时间线结算（Bug #13 核心，抽成纯函数脱离 socket/ref 单测）。
 *
 * 常规部分与原实现等价：按 `pendingIds`/`messageId` 标记失败气泡 + 清对应
 * loading 占位 + 收尾未终态工具块；新增 `event.reason` 透传到 `errorReason`，
 * 供渲染层区分「远程二次门控拒绝」等结构化原因走专属文案（见 message-list.tsx）。
 *
 * `strandedSend` 非空时（远程续写的用户输入在 `run.human` 落地前就被拒绝，
 * 从未在 timeline 出现过——`use-session-stream.ts` 的 `remotePendingSendRef`
 * 判定）追加一条本地失败气泡，`id` 由调用方生成好传入（保持本函数纯粹，
 * 不内部调用 `clientSnowflakeId`），不让用户输入凭空消失。
 */
export function settleErrorTimeline(
  messages: TimelineMessage[],
  event: {
    messageId: string | null;
    pendingIds: readonly string[];
    error: string;
    reason?: string;
  },
  strandedSend: { id: string; content: string } | null,
): TimelineMessage[] {
  const failedIds = new Set<string>(event.pendingIds);
  if (event.messageId) failedIds.add(event.messageId);
  const loadingIdsToDrop = new Set<string>();
  for (const id of failedIds) loadingIdsToDrop.add(`loading-${id}`);
  const errorText = event.error.slice(0, 200);
  const next = messages
    .filter((m) => !loadingIdsToDrop.has(m.id))
    .map((m) =>
      failedIds.has(m.id)
        ? {
            ...m,
            failed: true,
            pending: false,
            streaming: false,
            errorText,
            ...(event.reason ? { errorReason: event.reason } : {}),
          }
        : m,
    );
  const withStranded = strandedSend
    ? [
        ...next,
        {
          id: strandedSend.id,
          role: "user" as const,
          content: strandedSend.content,
          failed: true,
          errorText,
          ...(event.reason ? { errorReason: event.reason } : {}),
        },
      ]
    : next;
  return settleUnfinishedToolCalls(withStranded);
}

/**
 * 会话流式状态 hook：拉历史 + 订阅 SESSION_WS 事件 → 维护 TimelineMessage 列表、
 * running、compaction、历史分页，并暴露 send/interrupt/loadMoreHistory 与 apply。
 * sessionId 为 null 时惰性 inert（不请求不订阅），可安全挂载。
 *
 * 迁自 `apps/web-agent/src/hooks/use-session-stream.ts`（Task 6）：原实现直接
 * 依赖 jotai atoms（用量/标题）与 web-agent 专属基础设施（`getSessionSocket()`/
 * `@/rest/session`/`@/rest/remote-devices`），本包禁止这些依赖，故：
 * - atoms 写入点全部改为 {@link UseSessionStreamCallbacks} 回调参数，由调用方
 *   （web-agent 薄桥）接回 atoms；
 * - session socket 经 `getSocket` 参数注入（`SessionSocketLike` 结构化类型，
 *   不绑定 socket.io-client 具体实现）；
 * - `fetchPending`（本机排队消息）与 `fetchActiveRun`（远程 reclaim 查询）原是
 *   `@/rest/*` 直连，均提升为 `SessionTransport` 契约方法（声明扩展，见
 *   transport.ts），hook 内部经 transport 路由。
 *
 * L3 remote 分支（`remoteDeviceId` 非空）：该 sessionId 是远程设备 B 上的会话。
 * - 首屏历史走 `transport.fetchHistory`（B 侧与本地 REST 共用同一份装配，返回
 *   真正的 `HistoryResponse`，映射与本地完全一致），不走本地
 *   `transport.fetchPending`（远程无该概念）。
 * - **session socket 订阅不变**——B 的运行帧经 A 侧 `RemoteRunService` 影子重发到
 *   本地 SESSION_WS_EVENTS 总线，A 的 SessionGateway 照常转发到 room=sessionId，
 *   前端订阅同一个 sessionId 即可像本地会话一样收到实时帧，本 hook 无需为 remote
 *   改造任何 socket.on 逻辑。
 * - send 走 `transport.startRun(mode:"append")`，interrupt 走 `transport.interrupt`：
 *   两者都要带上「当前有效的 streamId」——远程控制帧靠 streamId 在云网关路由到
 *   正确的目标设备，interrupt 必须使用同一会话最近一次 run 的 streamId
 *   （`remoteStreamIdRef`，初值取 `remoteInitialStreamId`：首屏由起手台刚发起
 *   create 时带入，否则为 null——此时若用户直接中断会是 no-op，是 Phase A 已知
 *   限制）。
 */
export function useSessionStream(
  sessionId: string | null,
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
  transport: SessionTransport,
  getSocket: () => SessionSocketLike,
  callbacks: UseSessionStreamCallbacks,
  remoteDeviceId?: string | null,
  remoteInitialStreamId?: string | null,
): SessionStream {
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [running, setRunning] = useState(false);
  const messagesRef = useRef<TimelineMessage[]>([]);
  const oldestMessageIdRef = useRef<string | null>(null);
  const hasMoreHistoryRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  /** remote 分支当前有效的 streamId（供 interrupt 路由用），见上方 hook 注释。 */
  const remoteStreamIdRef = useRef<string | null>(null);
  /**
   * 切会话时那次异步 `fetchActiveRun` 的 running 校正是否已作废。服务端快照拍
   * 于请求发出的时刻，响应到达前本会话若已有更新的权威事实（收到终止帧
   * done/interrupted/error，或本端刚发起了一次新 run），就不能再按那份过期快照
   * 校正 running——拨回 true 会没有终止帧来清（又一次永久卡死），拨回 false 则
   * 会误清掉刚起的 run。每次切会话在同一个 effect 里重置为 false。
   */
  const remoteRunProbeStaleRef = useRef(false);
  /**
   * remote 续写「刚发出去、还没等到 run.human 落地」的暂存内容（Bug #13）。
   * `send()` 的 remote 分支不做本地乐观占位（见该函数注释），真实 user 气泡
   * 完全交给 `onHuman`；但 B 侧二次门控等预检拒绝发生在 run.human 之前，
   * 前端对这条消息一无所知——这个 ref 就是唯一留存，供 `onError` 在判定
   * 「这条消息终究没有落地」时补一条本地失败气泡。`onHuman`/`onInterrupted`
   * 触发时清空（要么真落地了，要么本轮已经结束不再需要）。同一时刻至多一条
   * 未落地的远程续写（`send()` 内已有 `running` 守卫防并发），单值足够。
   */
  const remotePendingSendRef = useRef<{ content: string } | null>(null);
  /** 压缩进行中标记。null = 未压缩；string = 压缩原因（用于 banner 文案）。 */
  const [compacting, setCompacting] = useState<
    null | "threshold" | "ctx-exceeded"
  >(null);

  // 回调一律经 ref 取最新值，**不进任何依赖数组**：它们只在事件/异步回调里被调用，
  // 不参与渲染。若把它们直接当依赖，调用方传一个内联箭头（每渲染新引用）就会让下方
  // 订阅 effect 每渲染重跑 → `setMessages([])` → 再渲染 → Maximum update depth exceeded。
  // 用 ref 兜住后，调用方传不传 useCallback 都安全。
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  /** 单一写入口：同步更新 ref 与 state。 */
  const apply = useCallback(
    (next: (prev: TimelineMessage[]) => TimelineMessage[]) => {
      messagesRef.current = next(messagesRef.current);
      setMessages(messagesRef.current);
    },
    [],
  );

  /**
   * onHuman 触发：把指定 user 消息从当前位置抽出、追加到数组末尾，清 pending
   * 标记（→ 离开 pending 区，进入聊天列表），并保证末尾存在 loading 占位 assistant 气泡。
   *
   * 用户手动发送时 messageId 由前端生成、append 同步用同一 id，run.human 到达时能 find 到。
   * 服务端注入的消息（如定时任务触发）前端没有乐观气泡，idx===-1，按事件携带的 content 新建。
   */
  const migrateHumanToTimeline = useCallback(
    (messageId: string, content: string): void => {
      apply((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) {
          const withoutLoading = prev.filter((m) => !m.loading);
          return [
            ...withoutLoading,
            { id: messageId, role: "user" as const, content },
            {
              id: `loading-${messageId}`,
              role: "assistant" as const,
              content: "",
              loading: true,
            },
          ];
        }
        // 同 batch 多条 user 时（onHuman 连发多次），第一次会 append loading，
        // 后续每次必须把 loading 重新抽出再附到末尾，否则后到的 user 会被插在
        // loading 上面，loading 卡在用户消息中间。
        const target = { ...prev[idx], pending: false };
        const withoutTarget = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        const existingLoading = withoutTarget.find((m) => m.loading);
        const withoutLoading = withoutTarget.filter((m) => !m.loading);
        const loading = existingLoading ?? {
          id: `loading-${messageId}`,
          role: "assistant" as const,
          content: "",
          loading: true,
        };
        return [...withoutLoading, target, loading];
      });
    },
    [apply],
  );

  /** 按 messageId 累加流式 delta；不存在则新建 assistant 气泡。 */
  const upsertChunk = useCallback(
    (messageId: string, delta: string, streaming: boolean) => {
      apply((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) {
          return [
            ...prev,
            { id: messageId, role: "assistant", content: delta, streaming },
          ];
        }
        const copy = [...prev];
        const existing = copy[idx];
        copy[idx] = {
          ...existing,
          content: streaming ? existing.content + delta : delta,
          streaming,
        };
        return copy;
      });
    },
    [apply],
  );

  useEffect(() => {
    if (!sessionId) return;
    // 切换 session：清空上一轮 timeline + inflight 状态 + usage 累计。否则
    // 后面的「合并历史 + socketArrived」逻辑会把旧 session 的消息当成「socket 已先到」
    // 保留下来，两段对话就混在一起。
    messagesRef.current = [];
    setMessages([]);
    // remote 且带初始 streamId（起手台 create 刚发起、首轮尚在跑）→ 乐观置 running；
    // 否则（本地 / 直接进入远程会话未带 streamId）与原行为一致先置 false，
    // 后续本地分支按 history.inflight 校正，remote 分支按下方 fetchActiveRun
    // 的服务端权威结果校正（乐观值只是首帧观感，不是最终事实）。
    setRunning(!!(remoteDeviceId && remoteInitialStreamId));
    oldestMessageIdRef.current = null;
    hasMoreHistoryRef.current = true;
    setHasMoreHistory(true);
    setHistoryError(false);
    remoteStreamIdRef.current = remoteDeviceId
      ? (remoteInitialStreamId ?? null)
      : null;
    // 切会话：上一个会话的「未落地远程续写」暂存不该带进新会话。
    remotePendingSendRef.current = null;
    callbacksRef.current.onUsageReset?.(sessionId);
    let cancelled = false;
    setHistoryLoading(true);

    if (remoteDeviceId) {
      // reclaim + running 校正：**无条件**查一次 transport.fetchActiveRun。
      //
      // 原实现被 `remoteStreamIdRef.current == null` 门住，恰好在「URL 带
      // streamId」时跳过——而那正是最需要校正的场景：`?streamId=` 是一次性
      // 交接参数，刷新/后退/书签重进时它是陈旧值（那条流早已终止，网关的
      // agentRunRoutes 已删、本 transport 的 RemoteRunTracker 也从未 register
      // 过它），上面的乐观 setRunning(true) 于是永远等不到 done/error/interrupted
      // → running 永久卡 true → 停止按钮常亮 + send() 的 I3 守卫吞掉一切输入。
      // 现在按服务端权威结果校正：run==null（run 已结束，findRunBySession 返回
      // null）→ 清 streamId + running=false；run!=null → 回填 streamId +
      // running=true（真在跑，刷新后也能接上 HITL 路由与停止按钮）。
      //
      // 竞态守卫 remoteRunProbeStaleRef：请求在途期间若已收到本会话的终止帧，
      // 说明服务端快照已过期，不再把 running 拨回 true（否则又是一次永久卡死）。
      // 失败（如 web-main 远程实现如实抛「协议不支持 reclaim」）只吞掉，保持
      // 原有乐观值——不影响历史渲染。
      remoteRunProbeStaleRef.current = false;
      transport
        .fetchActiveRun(sessionId)
        .then((run) => {
          if (cancelled || remoteRunProbeStaleRef.current) return;
          if (run) {
            remoteStreamIdRef.current = run.streamId;
            setRunning(true);
          } else {
            remoteStreamIdRef.current = null;
            setRunning(false);
          }
        })
        .catch(() => {});
      // L3 remote：首屏历史走 L2c fetchHistory（经 transport）。B 侧现与本地
      // REST 共用 assembleHistoryMessages，回的是真正的 HistoryResponse（工具
      // 状态/结果/subSessionId 齐全、role="tool" 行已在服务端过滤），故映射与
      // 本地完全一致。不查本地 fetchPending（远程无该概念）；不显式传 limit
      // （与本地首屏一致，交由 B 端 listPage 默认值 50 兜底）。inflight /
      // sessionTotals / byMessage 跨设备刻意不传，见 HistoryResponseSchema 注释。
      transport
        .fetchHistory(sessionId)
        .then((res) => {
          if (cancelled) return;
          const initial: TimelineMessage[] = res.messages.map(
            historyMessageToTimeline,
          );
          // 合并：历史快照打底，但保留 socket 已先到的消息（不被覆盖）
          apply((current) => {
            const initialIds = new Set(initial.map((m) => m.id));
            const socketArrived = current.filter((m) => !initialIds.has(m.id));
            return [...initial, ...socketArrived];
          });
          oldestMessageIdRef.current = initial[0]?.id ?? null;
          hasMoreHistoryRef.current = res.hasMore;
          setHasMoreHistory(res.hasMore);
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("拉取远程会话历史失败", err);
          setHistoryError(true);
        })
        .finally(() => {
          if (!cancelled) setHistoryLoading(false);
        });
    } else {
      void Promise.all([
        transport.fetchHistory(sessionId),
        transport.fetchPending(sessionId),
      ])
        .then(([history, pending]) => {
          if (cancelled) return;
          const initial: TimelineMessage[] = history.messages.map(
            historyMessageToTimeline,
          );
          const historyIds = new Set(history.messages.map((m) => m.id));
          if (history.inflight) {
            setRunning(history.inflight.status === "streaming");
            // 只在真正 streaming 时推 inflight 气泡；done/interrupted 状态下
            // checkpointer 已持久化对应消息，再推一条会形成「双气泡」（一个完整、
            // 一个空带闪烁光标）。
            if (
              history.inflight.messageId &&
              history.inflight.status === "streaming" &&
              !historyIds.has(history.inflight.messageId)
            ) {
              // reasoning 也带上：避免「正文流中切回会话」时思考过程丢失。
              // durationMs=0 让 UI 直接显示「已思考」（流式秒数信息没存）；
              // 后续 ws 订阅 replay 的 reasoning chunk 会按 messageId 累加到此条上。
              initial.push({
                id: history.inflight.messageId,
                role: "assistant",
                content: history.inflight.content,
                // 决策轮（只有工具、正文为空）不设 streaming：进行态由工具块自己
                // 呈现，空正文挂闪烁光标没有意义（与 onSnapshot 同款判断）。
                ...(history.inflight.content !== "" ||
                history.inflight.toolCalls.length === 0
                  ? { streaming: true as const }
                  : {}),
                // 已流过去的 tool_call args 前缀：中途打开会话时靠它接上流式预览。
                ...(history.inflight.toolCalls.length > 0
                  ? {
                      toolCalls: mergeInflightToolCalls(
                        undefined,
                        history.inflight.toolCalls,
                      ),
                    }
                  : {}),
                ...(history.inflight.reasoning
                  ? {
                      reasoning: history.inflight.reasoning,
                      // 服务端记录的真实 reasoning 起始时刻；缺失时不设 startedAt
                      // （ReasoningBlock 走 streaming + 无 startedAt 的 fallback「思考中 0.0s」分支）
                      ...(history.inflight.reasoningStartedAt !== null &&
                      history.inflight.reasoningStartedAt !== undefined
                        ? {
                            reasoningStartedAt:
                              history.inflight.reasoningStartedAt,
                          }
                        : {}),
                    }
                  : {}),
              });
            }
          }
          for (const p of pending.pending) {
            if (p.status === "processed") {
              continue;
            }
            if (historyIds.has(p.id)) {
              if (p.status === "failed") {
                const idx = initial.findIndex((m) => m.id === p.id);
                if (idx !== -1) {
                  initial[idx] = { ...initial[idx], failed: true };
                }
              }
              continue;
            }
            if (p.status === "pending") {
              // 排队中（runner 还没认领、从未入库）→ 输入框上方 pending 区
              initial.push({
                id: p.id,
                role: "user",
                content: p.content,
                pending: true,
              });
              continue;
            }
            // processing / failed 且不在首页历史 id 集合里：
            // - inHistory=true → 已落入 session_messages（只是在更早的历史页）。
            //   跳过，由历史在正确 seq 位置展示——否则会被追加到时间线末尾，造成
            //   "失败/旧消息堆在最后面"（首页 historyIds 不含分页深处的 id）。
            // - inHistory=false → 孤儿（如 run.human 记录前就失败）。它是最新的，
            //   历史里没有，追加到末尾才看得到 + 可重试。
            if (!p.inHistory) {
              initial.push({
                id: p.id,
                role: "user",
                content: p.content,
                failed: p.status === "failed",
              });
            }
          }
          // 合并：历史快照打底，但保留 socket 已先到的消息（不被覆盖）
          apply((current) => {
            const initialIds = new Set(initial.map((m) => m.id));
            const socketArrived = current.filter((m) => !initialIds.has(m.id));
            return [...initial, ...socketArrived];
          });
          if (history.sessionTotals) {
            callbacksRef.current.onUsageInitial?.(sessionId, {
              sessionTotals: history.sessionTotals,
              byMessage: history.byMessage,
            });
          } else {
            // 防御：首次必有 sessionTotals
            callbacksRef.current.onUsageBatch?.(sessionId, history.byMessage);
          }
          oldestMessageIdRef.current = initial[0]?.id ?? null;
          hasMoreHistoryRef.current = history.hasMore;
          setHasMoreHistory(history.hasMore);
        })
        .catch(() => {
          // 历史拉取失败（如远程子会话在对端、瞬时网络）——留空白由实时流填充，
          // 不让 rejection 冒泡成 dev overlay 崩屏/unhandled rejection。
        })
        .finally(() => {
          if (!cancelled) setHistoryLoading(false);
        });
    }

    const socket = getSocket();
    const subscribe = () =>
      socket.emit(SESSION_WS_EVENTS.subscribe, { sessionId });

    const onHuman = (e: RunHumanEvent) => {
      if (e.sessionId !== sessionId) return;
      // 消息真正落地了：remote 续写暂存的「未落地」标记不再需要（Bug #13，
      // 见 remotePendingSendRef 声明处注释）。
      remotePendingSendRef.current = null;
      migrateHumanToTimeline(e.messageId, e.content);
    };
    const onReasoning = (e: RunReasoningChunkEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(true);
      apply((prev) => {
        // 首个 reasoning 到达：清掉 loading 占位。任何时候至多有 1 个 loading
        // （migrateHumanToTimeline 用 `if (next.some(m => m.loading)) return next`
        // 保证），全清安全；不动 user 的 pending 标记（那个只由 run.human 清）。
        const withoutLoading = prev.filter((m) => !m.loading);
        const idx = withoutLoading.findIndex((m) => m.id === e.messageId);
        // 不存在则创建 assistant 占位：reasoningStartedAt 设为现在，
        // content 为空（等 onChunk 到达时填）
        if (idx === -1) {
          return [
            ...withoutLoading,
            {
              id: e.messageId,
              role: "assistant" as const,
              content: "",
              reasoning: e.delta,
              reasoningStartedAt: Date.now(),
            },
          ];
        }
        const copy = [...withoutLoading];
        const existing = copy[idx];
        copy[idx] = {
          ...existing,
          reasoning: (existing.reasoning ?? "") + e.delta,
          // existing.reasoningStartedAt 来自 inflight 透传（刷新场景）
          // 或来自 idx===-1 分支首次创建（fresh 流式场景，已设 Date.now()）
          // 两种情况都已正确赋值，不再用「?? Date.now()」覆盖
          reasoningStartedAt: existing.reasoningStartedAt,
        };
        return copy;
      });
    };
    /**
     * LLM 本轮 reasoning_content 结束、转入 tool_calls token 流时由 graph 检测后
     * emit 出来。前端据此锁 reasoningDurationMs，让「思考中 Xs」尽早切到「已思考 Xs」，
     * 避免把后续几秒的 tool_calls token 流时间也算进思考时长（对长 tool_call args
     * 尤其明显——一个长 curl + python 脚本可能要流好几秒）。
     *
     * content-having 轮（无 tool_calls）：reasoning_done 不会触发；
     * onChunk 收到首个 content 字时已经锁过 duration，行为不变。
     */
    const onReasoningDone = (e: RunReasoningDoneEvent) => {
      if (e.sessionId !== sessionId) return;
      apply((prev) =>
        prev.map((m) => {
          if (m.id !== e.messageId) return m;
          if (
            m.reasoningStartedAt === undefined ||
            m.reasoningDurationMs !== undefined
          ) {
            return m; // 没记 startedAt 或已锁过，跳过
          }
          return {
            ...m,
            reasoningDurationMs: Date.now() - m.reasoningStartedAt,
          };
        }),
      );
    };
    const onChunk = (e: RunChunkEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(true);
      apply((prev) => {
        // 首个 chunk 到达：
        // 1) 清掉 loading 占位（任何时候至多 1 个，全清安全）
        // 2) 该消息若有进行中的 reasoning（startedAt 已设、durationMs 未设），
        //    在第一次 chunk 到达时锁定 reasoningDurationMs
        //
        // pending user 标记的清理交给 run.human 事件（服务端真相），不在这里顺手做。
        const withoutLoading = prev.filter((m) => !m.loading);
        return withoutLoading.map((m) => {
          if (m.id === e.messageId) {
            const next = m.failed ? { ...m, failed: false } : m;
            if (
              next.reasoningStartedAt !== undefined &&
              next.reasoningDurationMs === undefined
            ) {
              return {
                ...next,
                reasoningDurationMs: Date.now() - next.reasoningStartedAt,
              };
            }
            return next;
          }
          return m;
        });
      });
      upsertChunk(e.messageId, e.delta, true);
    };
    /**
     * subscribe 回放：按 messageId **SET**（覆盖，非累加）本轮全量 reasoning/content，
     * 与 HTTP inflight push 互为幂等，根治回放叠加 / 断线重连的文本翻倍。
     * 缺失则按快照建气泡；后续真正的增量仍走 onReasoning / onChunk（append）。
     */
    const onSnapshot = (e: RunSnapshotEvent) => {
      if (e.sessionId !== sessionId) return;
      setRunning(true);
      // 决策轮（只有工具、正文为空）不设 streaming：空正文的闪烁光标没有意义，
      // 进行态由工具块自己呈现（与 onToolArgsDelta 建壳时的判断一致）。
      const streaming = e.content !== "" || e.toolCalls.length === 0;
      apply((prev) => {
        const withoutLoading = prev.filter((m) => !m.loading);
        const idx = withoutLoading.findIndex((m) => m.id === e.messageId);
        if (idx === -1) {
          return [
            ...withoutLoading,
            {
              id: e.messageId,
              role: "assistant" as const,
              content: e.content,
              ...(streaming ? { streaming: true } : {}),
              ...(e.reasoning ? { reasoning: e.reasoning } : {}),
              ...(e.reasoningStartedAt !== null
                ? { reasoningStartedAt: e.reasoningStartedAt }
                : {}),
              ...(e.toolCalls.length > 0
                ? { toolCalls: mergeInflightToolCalls(undefined, e.toolCalls) }
                : {}),
            },
          ];
        }
        const copy = [...withoutLoading];
        const existing = copy[idx];
        copy[idx] = {
          ...existing,
          content: e.content, // SET 覆盖，不累加
          ...(streaming ? { streaming: true } : {}),
          // reasoning 仅在快照非空时覆盖，避免空快照抹掉已有 reasoning
          reasoning: e.reasoning || existing.reasoning,
          reasoningStartedAt:
            e.reasoningStartedAt ?? existing.reasoningStartedAt,
          toolCalls: mergeInflightToolCalls(existing.toolCalls, e.toolCalls),
        };
        return copy;
      });
    };
    const onDone = (e: RunDoneEvent) => {
      if (e.sessionId !== sessionId) return;
      remoteRunProbeStaleRef.current = true;
      setRunning(false);
      apply((prev) =>
        prev.map((m) =>
          m.id === e.messageId
            ? { ...m, content: e.content, streaming: false }
            : m,
        ),
      );
    };
    const onInterrupted = (e: RunInterruptedEvent) => {
      if (e.sessionId !== sessionId) return;
      remoteRunProbeStaleRef.current = true;
      setRunning(false);
      // 该会话本轮如果真正跑起来过，run.human 早已落地，remote 续写的
      // 乐观占位没有留存的必要——清掉，避免和下一次 send() 的暂存串台。
      remotePendingSendRef.current = null;
      apply((prev) => settleInterruptedTimeline(prev, e.messageId));
    };
    const onError = (e: RunErrorEvent) => {
      if (e.sessionId !== sessionId) return;
      remoteRunProbeStaleRef.current = true;
      setRunning(false);
      // 【Bug #13】远程二次门控等预检拒绝（reason="agent_not_remotable"）发生在
      // B 侧建会话/回 run.human 之前——这条 user 消息从未在 timeline 里出现过。
      // remotePendingSendRef 是 send() 时暂存的「刚发出去、还没等到 run.human
      // 落地」的内容：仍非空说明这条消息至今没有真正落地，交给
      // settleErrorTimeline 补一条本地失败气泡，不让用户输入凭空消失。
      const strandedSend = remotePendingSendRef.current
        ? {
            id: clientSnowflakeId(),
            content: remotePendingSendRef.current.content,
          }
        : null;
      remotePendingSendRef.current = null;
      apply((prev) => settleErrorTimeline(prev, e, strandedSend));
    };
    const onUsage = (e: RunUsageEvent) => {
      if (e.sessionId !== sessionId) return;
      callbacksRef.current.onUsageEvent?.(sessionId, e);
    };
    // 标题事件全局广播（不限当前 session）：按事件 sessionId patch 列表 + 标题栏
    //（两处都读 sessionsAtom）。后台 LLM 生成标题完成后实时刷新。
    const onTitleUpdatedEvent = (e: SessionTitleUpdatedEvent) => {
      callbacksRef.current.onTitleUpdated?.(e.sessionId, e.title);
    };
    /**
     * LLM 正在逐 token 生成某个 tool_call 的参数 JSON。
     *
     * 定位顺序是**先按 toolCallId 全时间线找、再按 messageId 落位**，不能反过来：
     * 该块可能已经被 start/end 建在别的消息上（乱序到达 / 重连补发 / provider
     * 的 messageId 与 args 流不一致）。原实现只在 `e.messageId` 那条消息内部找，
     * 找不到就 push 一个 `status:"streaming"` 的新块——同一个 toolCallId 于是
     * 在时间线上出现两份，其中一份是永远转圈的 streaming 幽灵，且因
     * `status === "streaming"` 会让 todo_write / ask_question / present_file 等
     * 卡片分支全部退化成通用 JSON 块。这里改为命中既有块就**只 append argsText**，
     * 绝不回写 status（终态块不会被打回 streaming）。
     */
    const onToolArgsDelta = (e: RunToolCallArgsDeltaEvent) => {
      if (e.sessionId !== sessionId) return;
      // 个别 provider 流里不带 id → 跳过预览，等 onToolStart。
      const toolCallId = e.toolCallId;
      if (!toolCallId) return;
      apply((rawPrev) => {
        // 决策轮（tool_calls、content 空）没有 reasoning/chunk 事件（云网关不透传
        // reasoning，空 delta 不发 chunk），loading 占位无人清 → 「…」悬置在工具块
        // 上方。本轮首个工具事件到达即视为 LLM 已应答，清掉占位。
        const prev = rawPrev.filter((m) => !m.loading);
        // 1) 全时间线找同 toolCallId 的既有块：只累加 argsText，status 原样保留。
        const ownerIdx = prev.findIndex((m) =>
          m.toolCalls?.some((t) => t.toolCallId === toolCallId),
        );
        if (ownerIdx !== -1) {
          const copy = [...prev];
          const owner = copy[ownerIdx];
          copy[ownerIdx] = {
            ...owner,
            toolCalls: (owner.toolCalls ?? []).map((t) =>
              t.toolCallId === toolCallId
                ? {
                    ...t,
                    name: e.name ?? t.name,
                    argsText: (t.argsText ?? "") + e.delta,
                  }
                : t,
            ),
          };
          return copy;
        }
        // 2) 确实是新块：挂到 e.messageId 那条消息上。
        const fresh = {
          toolCallId,
          name: e.name ?? "",
          status: "streaming" as const,
          argsText: e.delta,
        };
        const idx = prev.findIndex((m) => m.id === e.messageId);
        // 中间决策轮可能无 content/reasoning：不存在则建一个无正文的 assistant 壳，
        // 不设 streaming（避免空正文闪烁光标），由 toolCalls 块自身呈现进行态。
        if (idx === -1) {
          return [
            ...prev,
            {
              id: e.messageId,
              role: "assistant" as const,
              content: "",
              toolCalls: [fresh],
            },
          ];
        }
        const copy = [...prev];
        copy[idx] = {
          ...copy[idx],
          toolCalls: [...(copy[idx].toolCalls ?? []), fresh],
        };
        return copy;
      });
    };
    /**
     * 工具开始执行：填权威 args、升级 running、清流式文本。
     *
     * 宿主消息不存在时**建壳**（与 onToolArgsDelta 同款写法）。原实现是
     * `prev.map(m => m.id !== e.messageId ? m : ...)`——只改不建，宿主消息不在
     * 时间线上（args 流不带 id 的 provider 直达 start、乱序到达、跨设备观察通道
     * 中途接入没有前序帧）就把整个事件**静默吞掉**，那个工具块要么根本不出现、
     * 要么永远停在 args_delta 建出的 streaming 态转圈。原注释声称本函数处理
     * 「本轮首个工具事件」，但 map-only 的结构做不到，注释与实现不符，一并修正。
     */
    const onToolStart = (e: RunToolCallStartEvent) => {
      if (e.sessionId !== sessionId) return;
      apply((rawPrev) => {
        // 同 onToolArgsDelta：本轮首个工具事件到达即视为 LLM 已应答，清 loading 占位。
        const prev = rawPrev.filter((m) => !m.loading);
        const upgrade = (m: TimelineMessage): TimelineMessage => {
          // tool_call 开始 = 本轮 LLM 文本已收尾。
          // 1) 锁住 reasoningDurationMs，否则「思考中 Xs」会一直跳到本轮 LLM 结束才能切回「已思考」。
          // 2) 清 streaming 标记，否则中间决策轮（content 已停 + tool_call 进行中）
          //    气泡尾部的闪烁光标永不熄灭 —— runDone 要等整轮跑完才发。
          const lockDuration =
            m.reasoningStartedAt !== undefined &&
            m.reasoningDurationMs === undefined
              ? { reasoningDurationMs: Date.now() - m.reasoningStartedAt }
              : {};
          // 合并到流式阶段已建的同一块（按 toolCallId 命中）：升级 running、填权威
          // args、清流式文本。命不中（无流式预览 / 重复 start）则新建/覆盖。
          // 按 toolCallId 命中 = 幂等：重复 start 不会再 push 出重复块。
          const list = m.toolCalls ? [...m.toolCalls] : [];
          const i = list.findIndex((t) => t.toolCallId === e.toolCallId);
          const next = {
            toolCallId: e.toolCallId,
            name: e.name,
            args: e.args,
            status: "running" as const,
            argsText: undefined,
          };
          if (i === -1) {
            list.push(next);
          } else {
            list[i] = { ...list[i], ...next };
          }
          return { ...m, ...lockDuration, streaming: false, toolCalls: list };
        };
        const idx = prev.findIndex((m) => m.id === e.messageId);
        // 建壳幂等：壳的 id 就是 e.messageId，重复 start 第二次会命中上面的
        // findIndex 走覆盖分支，不会建出第二条消息，也不会建出第二个块。
        if (idx === -1) {
          return [
            ...prev,
            upgrade({ id: e.messageId, role: "assistant", content: "" }),
          ];
        }
        const copy = [...prev];
        copy[idx] = upgrade(copy[idx]);
        return copy;
      });
    };
    const onToolProgress = (e: RunToolCallProgressEvent) => {
      if (e.sessionId !== sessionId) return;
      apply((prev) =>
        prev.map((m) =>
          m.toolCalls?.some((t) => t.toolCallId === e.toolCallId)
            ? {
                ...m,
                toolCalls: m.toolCalls.map((t) =>
                  t.toolCallId === e.toolCallId
                    ? { ...t, progress: (t.progress ?? "") + e.delta }
                    : t,
                ),
              }
            : m,
        ),
      );
    };
    /**
     * 工具执行结束：按 toolCallId 全局找到块并置终态。
     *
     * 找不到块时**兜底建壳建块**并直接置终态，而不是像原实现那样静默丢弃——end
     * 事件自带 `messageId`/`toolCallId`/`name`/`ok`/`resultPreview`，字段足够渲染
     * 一张完整的终态卡。丢掉它的代价是：前序 start 若因任何原因没落到时间线上，
     * 这个工具就永远没有终态、卡片永久转圈（且没有任何后续事件能救它）。
     */
    const onToolEnd = (
      // gateway 已剥 content；前端只用 resultPreview
      e: Omit<RunToolCallEndEvent, "content">,
    ) => {
      if (e.sessionId !== sessionId) return;
      const status = e.ok ? ("ok" as const) : ("error" as const);
      apply((prev) => {
        const ownerIdx = prev.findIndex((m) =>
          m.toolCalls?.some((t) => t.toolCallId === e.toolCallId),
        );
        // 幂等：重复 end 走这条命中分支，重复写同样的终态，不产生新块。
        if (ownerIdx !== -1) {
          const copy = [...prev];
          const owner = copy[ownerIdx];
          copy[ownerIdx] = {
            ...owner,
            toolCalls: (owner.toolCalls ?? []).map((t) =>
              t.toolCallId === e.toolCallId
                ? { ...t, status, result: e.resultPreview }
                : t,
            ),
          };
          return copy;
        }
        const settled = {
          toolCallId: e.toolCallId,
          name: e.name,
          status,
          result: e.resultPreview,
        };
        const idx = prev.findIndex((m) => m.id === e.messageId);
        if (idx !== -1) {
          const copy = [...prev];
          copy[idx] = {
            ...copy[idx],
            toolCalls: [...(copy[idx].toolCalls ?? []), settled],
          };
          return copy;
        }
        // 宿主消息也不在：建壳。此路径下本轮 LLM 已应答完毕，loading 占位一并清掉。
        return [
          ...prev.filter((m) => !m.loading),
          {
            id: e.messageId,
            role: "assistant" as const,
            content: "",
            toolCalls: [settled],
          },
        ];
      });
    };
    const onSubagentSpawned = (e: RunSubagentSpawnedEvent) => {
      if (e.sessionId !== sessionId) return;
      apply((prev) =>
        claimSubagentOnTimeline(prev, e.toolCallId, e.subSessionId),
      );
    };
    const onSubagentSettled = (e: RunSubagentSettledEvent) => {
      if (e.sessionId !== sessionId) return;
      apply((prev) =>
        settleSubagentOnTimeline(
          prev,
          e.toolCallId,
          JSON.stringify({
            subSessionId: e.subSessionId,
            status: e.status,
            output: e.output,
          }),
        ),
      );
    };

    socket.on("connect", subscribe);
    if (socket.connected) subscribe();
    socket.on(SESSION_WS_EVENTS.runHuman, onHuman);
    socket.on(SESSION_WS_EVENTS.runReasoning, onReasoning);
    socket.on(SESSION_WS_EVENTS.runReasoningDone, onReasoningDone);
    socket.on(SESSION_WS_EVENTS.runChunk, onChunk);
    socket.on(SESSION_WS_EVENTS.runSnapshot, onSnapshot);
    socket.on(SESSION_WS_EVENTS.runDone, onDone);
    socket.on(SESSION_WS_EVENTS.runInterrupted, onInterrupted);
    socket.on(SESSION_WS_EVENTS.runError, onError);
    socket.on(SESSION_WS_EVENTS.runUsage, onUsage);
    socket.on(SESSION_WS_EVENTS.titleUpdated, onTitleUpdatedEvent);
    socket.on(SESSION_WS_EVENTS.runToolCallArgsDelta, onToolArgsDelta);
    socket.on(SESSION_WS_EVENTS.runToolCallStart, onToolStart);
    socket.on(SESSION_WS_EVENTS.runToolCallProgress, onToolProgress);
    socket.on(SESSION_WS_EVENTS.runToolCallEnd, onToolEnd);
    socket.on(SESSION_WS_EVENTS.runSubagentSpawned, onSubagentSpawned);
    socket.on(SESSION_WS_EVENTS.runSubagentSettled, onSubagentSettled);

    // === Compaction 三事件 —— banner 状态 + 完成后触发 history 重新拉取 ===
    const onCompactionStart = (payload: {
      sessionId: string;
      reason: "threshold" | "ctx-exceeded";
    }) => {
      if (payload.sessionId !== sessionId) return;
      setCompacting(payload.reason);
    };
    const onCompactionDone = (payload: { sessionId: string }) => {
      if (payload.sessionId !== sessionId) return;
      setCompacting(null);
      // 注：history 不是 react-query 管理，没法直接 invalidate。新插入的
      // compaction 占位行要等用户下次进入 session 或滚动加载时才出现。
      // v1 接受；v2 可加 fetchHistory 然后 merge 进 messages atom。
    };
    const onCompactionError = (payload: {
      sessionId: string;
      error: string;
    }) => {
      if (payload.sessionId !== sessionId) return;
      setCompacting(null);
      // 暂无统一 toast 库；用 console.warn 占位，banner 自然撤掉即可
      console.warn(`[compaction] error: ${payload.error}`);
    };
    socket.on(SESSION_WS_EVENTS.runCompactionStart, onCompactionStart);
    socket.on(SESSION_WS_EVENTS.runCompactionDone, onCompactionDone);
    socket.on(SESSION_WS_EVENTS.runCompactionError, onCompactionError);

    return () => {
      cancelled = true;
      // 离开旧 session：通知 gateway leave 房间，否则切换多个 session 后
      // socket 同时订阅一堆 room，每个 session 跑起来都推送过来浪费带宽。
      socket.emit(SESSION_WS_EVENTS.unsubscribe, { sessionId });
      socket.off("connect", subscribe);
      socket.off(SESSION_WS_EVENTS.runHuman, onHuman);
      socket.off(SESSION_WS_EVENTS.runReasoning, onReasoning);
      socket.off(SESSION_WS_EVENTS.runReasoningDone, onReasoningDone);
      socket.off(SESSION_WS_EVENTS.runChunk, onChunk);
      socket.off(SESSION_WS_EVENTS.runSnapshot, onSnapshot);
      socket.off(SESSION_WS_EVENTS.runDone, onDone);
      socket.off(SESSION_WS_EVENTS.runInterrupted, onInterrupted);
      socket.off(SESSION_WS_EVENTS.runError, onError);
      socket.off(SESSION_WS_EVENTS.runUsage, onUsage);
      socket.off(SESSION_WS_EVENTS.titleUpdated, onTitleUpdatedEvent);
      socket.off(SESSION_WS_EVENTS.runToolCallArgsDelta, onToolArgsDelta);
      socket.off(SESSION_WS_EVENTS.runToolCallStart, onToolStart);
      socket.off(SESSION_WS_EVENTS.runToolCallProgress, onToolProgress);
      socket.off(SESSION_WS_EVENTS.runToolCallEnd, onToolEnd);
      socket.off(SESSION_WS_EVENTS.runSubagentSpawned, onSubagentSpawned);
      socket.off(SESSION_WS_EVENTS.runSubagentSettled, onSubagentSettled);
      socket.off(SESSION_WS_EVENTS.runCompactionStart, onCompactionStart);
      socket.off(SESSION_WS_EVENTS.runCompactionDone, onCompactionDone);
      socket.off(SESSION_WS_EVENTS.runCompactionError, onCompactionError);
    };
  }, [
    sessionId,
    transport,
    getSocket,
    remoteDeviceId,
    remoteInitialStreamId,
    apply,
    upsertChunk,
    migrateHumanToTimeline,
  ]);

  /**
   * 会话页发送：前端生成最终 messageId（雪花），乐观插入 user 气泡到 pending 区，
   * 用雪花（非 UUID）使 human id 与服务端 assistant 雪花 / checkpointer / 事件流 /
   * session_messages.id 三处收口一致，历史与 inflight 去重才能命中。
   * append 传同一 id 给后端。这样 run.human 到达时能直接按 id 找到目标气泡迁移，
   * 不需要 tempId 替换 / pendingHumanIdsRef 缓存。
   *
   * loading 占位 + 迁出 pending 区到聊天区末尾，全部交给 onHuman 处理。
   */
  const send = useCallback(
    async (msg: string): Promise<boolean> => {
      if (!sessionId) return false;
      if (remoteDeviceId) {
        // I3 守卫：该远程会话已有活跃 run（running=true，含首轮 create 场景）时
        // 不再发起第二个 append——避免 B 侧同 sessionId 注册两套监听器导致
        // 帧翻倍、第一条 run.done 提前退订两套监听器、第二条对 A 不可见。
        // 本地会话（下方非 remote 分支）走 appendMessage 排队语义，不受影响。
        // server 侧 RemoteRunService.startRun 对同 (device,session) 也有 409
        // 兜底拒绝，这里提前短路只是省一次网络往返、给更快反馈。
        if (running) {
          // 返回 false 而非静默 return：调用方据此提示 + 回填输入框，
          // 否则 ChatInput 已经清空了编辑器，用户输入凭空消失（见 SessionStream.send）。
          console.warn("远程会话仍有 run 在进行中，请等待完成后再发送");
          return false;
        }
        // L3 remote 续写：不做本地乐观占位——B 侧 appendMessage 自己生成
        // messageId（randomUUID，与本地无法对齐），乐观插入的话，等真正的
        // run.human 帧到达时 id 对不上，会在 idx===-1 分支再建一条，形成
        // 重复气泡。真实的 user 气泡交给 onHuman 的兜底分支新建（与「服务端
        // 注入消息」同路径），只是要等一次 relay 往返才出现——用 setRunning(true)
        // 提前给出「已在处理」的即时反馈，减轻等待感。
        try {
          const { streamId } = await transport.startRun({
            mode: "append",
            sessionId,
            content: msg,
          });
          remoteStreamIdRef.current = streamId;
          // 本端刚起了一轮新 run：切会话那次 fetchActiveRun 的快照已过期，
          // 不能再让它把 running/streamId 拨回去（见该 ref 注释）。
          remoteRunProbeStaleRef.current = true;
          setRunning(true);
          // 暂存本轮内容（Bug #13）：streamId 已经拿到、A 本地已接受，但 B
          // 侧是否真的接受（二次门控）要等异步的 run.human/agentRunEnd 才知道。
          // 在此之前，这是这条用户输入唯一的留存——onHuman 落地后清空，
          // onError/onInterrupted 收尾时若仍非空，据此补一条失败气泡。
          remotePendingSendRef.current = { content: msg };
        } catch (err) {
          console.error("远程续写失败", err);
          // ChatInput onSend 后同步清空编辑器（不看成败），relay 抖动/超时时
          // 用户输入会凭空消失、无任何痕迹。这里补一条可见的 failed 本地气泡
          // （id 用本地雪花，不与 B 侧 run.human 的 randomUUID 冲突——本轮已
          // 失败、不会有 run.human 到达，故不影响 onHuman 去重），让用户看到
          // 输入还在且失败了。
          apply((prev) => [
            ...prev,
            {
              id: clientSnowflakeId(),
              role: "user",
              content: msg,
              failed: true,
            },
          ]);
        }
        return true;
      }
      const messageId = clientSnowflakeId();
      apply((prev) => [
        ...prev,
        { id: messageId, role: "user", content: msg, pending: true },
      ]);
      try {
        // messageId 显式传给 transport：本机乐观插入的气泡 id 必须与实际
        // append 落库的 id 一致，run.human 到达时才能按 id 精确匹配迁移。
        await transport.startRun({
          mode: "append",
          sessionId,
          content: msg,
          messageId,
        });
      } catch (err) {
        console.error("追加消息失败", err);
      }
      return true;
    },
    [sessionId, apply, remoteDeviceId, running, transport],
  );

  /**
   * Stop 按钮：本地经 socket 发中断信号；remote 经 relay 控制帧
   * （`transport.interrupt`），路由靠 `remoteStreamIdRef` 当前记的 streamId
   * ——若为 null（本页尚未发起过 run，如直接刷新进入一个仍在跑的远程会话）
   * 则无法路由到 B，no-op（Phase A 已知限制）。
   *
   * 【Bug #4】点击当帧先乐观本地结算（`setRunning(false)` +
   * `settleInterruptedTimeline`），不等 `transport.interrupt` 的网络往返、
   * 更不等后端 `run.interrupted` 事件——否则「思考中 Xs」计时器与打断按钮
   * 会在用户点完之后继续转好一截（甚至在 `onInterrupted` 从未补锁
   * `reasoningDurationMs` 的旧实现里永远转下去，即原 bug）。后端确认到达时
   * `onInterrupted`/`onError` 仍会再跑一次同一份结算逻辑对齐最终态——两次
   * 结算天然幂等，不会有视觉跳变；万一实际并未真正打断（如 B 侧仍在继续跑），
   * 下一帧 onChunk/onReasoning/onSnapshot 会把 running 重新拨回 true，不会
   * 永久卡在错误的「已停」态。
   */
  const interrupt = useCallback(() => {
    if (!sessionId) return;
    setRunning(false);
    apply((prev) => settleInterruptedTimeline(prev));
    if (remoteDeviceId) {
      // streamId 为 null 时的 warn + no-op 已下沉到 transport.interrupt 内部
      // （与本函数原有文案逐字一致，见 lib/session-transport.ts），此处不再重复判断。
      void transport
        .interrupt(remoteStreamIdRef.current, sessionId)
        .catch((err) => {
          console.error("远程中断失败", err);
        });
      return;
    }
    void transport.interrupt(null, sessionId);
  }, [sessionId, remoteDeviceId, transport, apply]);

  /**
   * 滚动到顶部触发：拉早于当前最旧消息的下一批 history。
   * - 锚定视口：prepend 前后 scrollTop 自动补偿，使用户当前看的消息不动
   * - 并发去重：loadingMoreRef 期间忽略重复触发
   * - remote 与 local 共用 cursor 分页与映射（B 侧现与本地 REST 共用同一份
   *   `assembleHistoryMessages`，`before` 语义与响应形状均同源），故不再有
   *   remote 专属分支；remote 的 `byMessage` 恒为 `{}`（用量不跨设备传，见
   *   `HistoryResponseSchema` 注释），onUsageBatch 合并空投影是无副作用的 no-op。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollContainerRef 是 RefObject，.current 故意不进依赖（与原实现一致）
  const loadMoreHistory = useCallback(async () => {
    if (!sessionId) return;
    if (!hasMoreHistoryRef.current) return;
    if (loadingMoreRef.current) return;
    const cursor = oldestMessageIdRef.current;
    if (!cursor) return;
    loadingMoreRef.current = true;
    const scroller = scrollContainerRef.current;
    const prevScrollHeight = scroller?.scrollHeight ?? 0;
    const prevScrollTop = scroller?.scrollTop ?? 0;
    try {
      const res = await transport.fetchHistory(sessionId, { before: cursor });
      const newMessages: TimelineMessage[] = res.messages.map(
        historyMessageToTimeline,
      );
      apply((prev) => {
        // 去重：socket 抢先到的或本地已有的不重复 prepend
        const existingIds = new Set(prev.map((m) => m.id));
        const fresh = newMessages.filter((m) => !existingIds.has(m.id));
        return [...fresh, ...prev];
      });
      callbacksRef.current.onUsageBatch?.(sessionId, res.byMessage);
      oldestMessageIdRef.current = res.messages[0]?.id ?? cursor;
      hasMoreHistoryRef.current = res.hasMore;
      setHasMoreHistory(res.hasMore);
      // 锚定视口：等 DOM 完成 prepend 后补偿 scrollTop
      requestAnimationFrame(() => {
        if (!scroller) return;
        const newScrollHeight = scroller.scrollHeight;
        scroller.scrollTop =
          prevScrollTop + (newScrollHeight - prevScrollHeight);
      });
    } catch (err) {
      console.error("加载更早消息失败", err);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [sessionId, apply, transport]);

  /**
   * 确认/取消一次待发送的工具调用（im_send_message / drive 分享类 confirm 型
   * HITL）。streamId 与 confirm/answer 一样：本地忽略（transport 内部丢弃），
   * remote 取 remoteStreamIdRef 当前值——为 null 时 transport.confirm 会抛错
   * （"远程会话 streamId 未就绪，请稍候重试"），与原 RemoteSessionProvider
   * 行为一致。
   */
  const confirm = useCallback(
    async (
      toolCallId: string,
      decision: "send" | "cancel",
      content?: string,
    ) => {
      if (!sessionId) return;
      const streamId = remoteDeviceId ? remoteStreamIdRef.current : null;
      await transport.confirm(
        streamId,
        sessionId,
        toolCallId,
        decision,
        content,
      );
    },
    [sessionId, remoteDeviceId, transport],
  );

  /** 提交 ask_question 型 HITL 的回答，streamId 处理同 confirm。 */
  const answer = useCallback(
    async (
      toolCallId: string,
      answers: { selected: string[]; other?: string }[],
    ) => {
      if (!sessionId) return;
      const streamId = remoteDeviceId ? remoteStreamIdRef.current : null;
      await transport.answer(streamId, sessionId, toolCallId, answers);
    },
    [sessionId, remoteDeviceId, transport],
  );

  /** 切换会话绑定模型：本地/远程分支判断已下沉到 transport 内部。 */
  const patchSessionModel = useCallback(
    async (modelConfigId: string) => {
      if (!sessionId) return;
      await transport.patchSessionModel(sessionId, modelConfigId);
    },
    [sessionId, transport],
  );

  return {
    messages,
    running,
    compacting,
    hasMoreHistory,
    historyLoading,
    historyError,
    apply,
    send,
    interrupt,
    loadMoreHistory,
    remoteDeviceId: remoteDeviceId ?? null,
    getStreamId: () => remoteStreamIdRef.current,
    confirm,
    answer,
    patchSessionModel,
  };
}
