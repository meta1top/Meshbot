"use client";

import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { apiClient, clientSnowflakeId } from "@meshbot/web-common";
import type {
  SessionRunEvents,
  SessionTransport,
} from "@meshbot/web-common/session";
import { artifactRawUrl } from "@/lib/artifact";
import { getSessionSocket } from "@/lib/socket";
import {
  answerRemote,
  confirmRemote,
  fetchRemoteArtifact,
  fetchRemoteHistory,
  fetchRemoteRun,
  fetchRemoteSessions,
  interruptRemoteRun,
  patchRemoteSessionModel,
  startRemoteRun,
  uploadRemoteArtifactToDrive,
} from "@/rest/remote-agent-sessions";
import { unwatchRemoteAgent, watchRemoteAgent } from "@/rest/remote-agents";
import {
  appendMessage,
  confirmAnswers,
  confirmSend,
  fetchHistory,
  fetchPending,
  listSessions,
  patchSession,
} from "@/rest/session";

/**
 * 经查询通道内联回传的上限：与 server-agent 的
 * `RemoteArtifactService.MAX_INLINE_BYTES` 保持一致（2MB），本地 readArtifact
 * 走既有 `/api/artifacts/raw` 拉完整字节后按此阈值判断，非服务端预先告知。
 */
const MAX_INLINE_BYTES = 2 * 1024 * 1024;

/** ArrayBuffer → base64（浏览器端，无 Buffer）；分块喂 String.fromCharCode 避免大文件栈溢出。 */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** 从 workspace 相对路径取文件名（最后一个 "/" 之后）。 */
function baseName(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}

/** run.* 事件名清单（服务端下发方向；不含 subscribe/unsubscribe/interrupt 三个客户端控制帧）。 */
const RUN_EVENT_NAMES: string[] = [
  SESSION_WS_EVENTS.titleUpdated,
  SESSION_WS_EVENTS.runHuman,
  SESSION_WS_EVENTS.runReasoning,
  SESSION_WS_EVENTS.runReasoningDone,
  SESSION_WS_EVENTS.runChunk,
  SESSION_WS_EVENTS.runSnapshot,
  SESSION_WS_EVENTS.runDone,
  SESSION_WS_EVENTS.runInterrupted,
  SESSION_WS_EVENTS.runError,
  SESSION_WS_EVENTS.runUsage,
  SESSION_WS_EVENTS.runToolCallStart,
  SESSION_WS_EVENTS.runToolCallProgress,
  SESSION_WS_EVENTS.runToolCallArgsDelta,
  SESSION_WS_EVENTS.runToolCallEnd,
  SESSION_WS_EVENTS.runCompactionStart,
  SESSION_WS_EVENTS.runCompactionDone,
  SESSION_WS_EVENTS.runCompactionError,
  SESSION_WS_EVENTS.runSubagentSpawned,
  SESSION_WS_EVENTS.runSubagentSettled,
];

/**
 * local/remote 共用的事件桥：两者在 web-agent（A 端）里都落在同一条
 * `ws/session` socket 上——远程会话的运行帧由 server-agent 的
 * `RemoteRunService` 影子重发进本地 `SESSION_WS_EVENTS` 总线，前端订阅同一个
 * sessionId 即可像本地会话一样收到实时帧（详见
 * use-session-stream.ts 顶部对 remote 分支的说明）。
 *
 * 只做「监听→转发」；不做 `session.subscribe`/`session.unsubscribe` 房间
 * 加入与离开——那需要 sessionId，而 `SessionTransport.subscribe` 契约不带
 * 该参数（工厂本身也是 session 无关的，一个实例可能被多个并发会话视图共用，
 * 如主视图 + IM dock）。房间加入/离开继续由调用方（hook）在拿到具体
 * sessionId 的地方直接对 `getSessionSocket()` 操作，与本适配器解耦——详见
 * 报告 concerns。
 */
function bridgeSessionSocketEvents(events: SessionRunEvents): () => void {
  const socket = getSessionSocket();
  const handlers = RUN_EVENT_NAMES.map(
    (name) =>
      [name, (payload: unknown) => events.onEvent(name, payload)] as const,
  );
  for (const [name, handler] of handlers) {
    socket.on(name, handler);
  }
  return () => {
    for (const [name, handler] of handlers) {
      socket.off(name, handler);
    }
  };
}

/**
 * 建立一路对目标远程 Agent 的观察（Agent 级观察通道，T18/T19）：调 T18 的
 * REST 端点拿 `watchId`，返回 unwatch 函数（幂等，DELETE 释放）。
 *
 * **只负责 watch 登记的生命周期，不负责事件投递**——真正的帧不经这条链路：
 * - `scope="session"`（推理帧）：经服务端影子桥已进了本机 `ws/session` 房间，
 *   `bridgeSessionSocketEvents` 订阅的既有 `RUN_EVENT_NAMES` 事件表直接收到，
 *   不需要额外转发。
 * - `scope="agent"`（会话生命周期镜像）：经专属信封 `REMOTE_AGENT_EVENTS.sessionEvent`
 *   下发到 `ws/events` 总线，由 `use-global-events.ts` 的 `onRemoteAgentSessionEvent`
 *   统一分发进 `remoteSessionsAtom`——与 web-main 的 `watchAgent(onEvent)`
 *   不同，web-agent 只有一条常驻的全局事件总线（每个浏览器标签页一条），不需要
 *   为每个 transport 实例单独建一条投递通道，故本函数忽略 `watchAgent` 的
 *   `onEvent` 回调参数，只管注册/注销。
 *
 * REST 往返期间调用方就 unwatch（如挂载后立刻卸载/切换 sessionId）：`stopped`
 * 标记短路，待 `watchId` 到手后立即补发 DELETE，不留悬挂通道等云端 idle 超时
 * 回收。
 */
function startAgentWatch(
  agentId: string,
  scope: "agent" | "session",
  sessionId?: string,
  /**
   * watchId 落地/释放时的回调（Task 16b：`createRemoteSessionTransport` 用它
   * 把 session 级 watchId 同步进 `sessionWatchIds` 表，供 `confirm`/`answer`
   * 回退取值）。REST 返回前为未调用（外层表里仍是初始登记的 `null`）；
   * `unwatch()` 时若已经拿到过 watchId，回调一次 `null` 释放登记。
   */
  onWatchId?: (watchId: string | null) => void,
  /**
   * REST 往返永久失败时的回调（Minor-1，T19b review）：修复前 `.catch` 只
   * `console.warn`，不通知调用方——`sessionWatchEntries` 里的句柄永远停在
   * `{watchId:null}`，`resolveControlAddress` 因此永远报「正在建立中，请稍候
   * 重试」，而真相是这条通道**永远不会建立成功**，重试多少次都一样。回调后
   * 调用方能把这个状态与「REST 还没回来」的正常等待窗口期区分开，给出准确
   * 的第三种文案。`stopped` 之后（调用方已经主动 unwatch）不再回调——通道
   * 已经是调用方主动放弃的，不需要再告知一次「失败」。
   */
  onFailed?: () => void,
): () => void {
  let watchId: string | null = null;
  let stopped = false;
  watchRemoteAgent(agentId, scope, sessionId)
    .then((res) => {
      if (stopped) {
        // 拿到 watchId 前调用方已经 unwatch 了——补发一次 DELETE，不留悬挂
        // 通道（否则要等云端 idle 超时才会被动回收）。
        unwatchRemoteAgent(agentId, res.watchId).catch(() => {});
        return;
      }
      watchId = res.watchId;
      onWatchId?.(watchId);
    })
    .catch((e) => {
      console.warn(`观察通道建立失败（agentId=${agentId} scope=${scope}）`, e);
      if (!stopped) onFailed?.();
    });
  return () => {
    stopped = true;
    if (watchId) {
      unwatchRemoteAgent(agentId, watchId).catch(() => {});
      watchId = null;
      onWatchId?.(null);
    }
  };
}

/**
 * 本机会话 SessionTransport：包 `rest/session.ts` REST 调用 + 本机
 * `ws/session` socket 事件桥。streamId 概念在本机不存在（append 语义由
 * sessionId 直接定位），startRun 恒返回 `{ streamId: null }`。
 */
export function createLocalSessionTransport(): SessionTransport {
  return {
    capabilities: { localRun: true },

    async listSessions() {
      return listSessions();
    },

    async fetchHistory(sessionId, opts) {
      return fetchHistory(sessionId, opts?.before);
    },

    async startRun(input) {
      if (input.mode === "create") {
        // 本地新建会话现由起手台（launcher-home.tsx / composer-target-bar.tsx）
        // 直接调用 rest/session.ts 的 createSession() 完成，拿到完整
        // { sessionId, session } 后再挂载 use-session-stream；本方法的返回
        // 形状（仅 streamId）无法回传新建的 sessionId。use-session-stream 恒
        // 在已知 sessionId 后才挂载，不会以 mode=create 调用本地 transport——
        // 这里如实抛错而非静默丢弃新建结果，避免调用方误用后收不到反馈。
        throw new Error(
          "本地会话新建请直接使用 rest/session.ts 的 createSession()——" +
            "SessionTransport.startRun 契约无法回传新建 sessionId",
        );
      }
      if (!input.sessionId) {
        throw new Error("append 模式必须携带 sessionId");
      }
      // messageId 优先用调用方预生成的（本地乐观插入气泡要与之精确匹配）；
      // 未传时兜底自生成，保持无匹配需求调用方的可用性。
      const messageId = input.messageId ?? clientSnowflakeId();
      await appendMessage(input.sessionId, messageId, input.content);
      return { streamId: null };
    },

    async interrupt(_streamId, sessionId) {
      getSessionSocket().emit(SESSION_WS_EVENTS.interrupt, { sessionId });
    },

    async confirm(_streamId, sessionId, toolCallId, decision, content) {
      await confirmSend(sessionId, toolCallId, decision, content);
    },

    async answer(_streamId, sessionId, toolCallId, answers) {
      await confirmAnswers(sessionId, toolCallId, answers);
    },

    async patchSessionModel(sessionId, modelConfigId) {
      await patchSession(sessionId, { modelConfigId });
    },

    async fetchPending(sessionId) {
      return fetchPending(sessionId);
    },

    async fetchActiveRun(_sessionId) {
      // 本地会话无独立 streamId 概念（append 语义由 sessionId 直接定位，
      // interrupt/confirm/answer 恒忽略 streamId）——use-session-stream 只在
      // remote 分支调用本方法，如实抛错而非伪造一个 null 结果掩盖误用。
      throw new Error(
        "本地会话无 streamId reclaim 概念（SessionTransport.fetchActiveRun 仅远程会话适用）",
      );
    },

    async readArtifact(_sessionId, path) {
      // 本地预览实际走 previewArtifactAtom + artifactRawUrl 直连
      // apiClient（见 artifact-body.tsx），不经本 transport；这里仍给出与
      // 远程语义对齐的真实实现（走既有 /api/artifacts/raw 拉字节后按 2MB
      // 阈值判断），供未来统一走 transport 的调用方使用。
      const name = baseName(path);
      const res = await apiClient.get<ArrayBuffer>(artifactRawUrl(path), {
        responseType: "arraybuffer",
      });
      const size = res.data.byteLength;
      if (size > MAX_INLINE_BYTES) {
        return { kind: "too-large", name, size };
      }
      return { kind: "content", name, base64: arrayBufferToBase64(res.data) };
    },

    async uploadArtifactToDrive(_sessionId, _path) {
      // 本地会话没有「按产物路径上传网盘」的既有端点（server-agent 只有
      // remote-agents 的 upload-drive 查询通道给跨设备场景用；本地预览走
      // previewArtifactAtom 直连，从未调用过这个方法）。补齐后端端点前如实
      // 抛错，不伪造一个假实现掩盖能力缺口。
      throw new Error("本地会话暂无产物上传网盘端点（仅远程会话支持）");
    },

    subscribe(events) {
      return bridgeSessionSocketEvents(events);
    },
  };
}

/**
 * A 端远程会话 SessionTransport：包 `rest/remote-agent-sessions.ts` 十个函数 +
 * 复用同一条本机 `ws/session` socket 做事件桥（B 的运行帧经服务端影子重发
 * 落在这条 socket 上，前端无需另开连接）。
 */
export function createRemoteSessionTransport(
  agentId: string,
): SessionTransport {
  /** 单路 session 级观察通道的可变句柄——`watchId` 字段被 `onWatchId` 回调原地
   * 覆写（REST 落地 / unwatch 释放），`resolveControlAddress` 每次现读这个
   * 字段，天然拿到「当前」值。`failed` 由 `onFailed` 回调原地置位（Minor-1，
   * T19b review）：REST 往返永久失败（网络错误 / 云端拒绝）与「REST 还没
   * 回来」是两种完全不同的排查线索——前者重试无意义，必须与后者区分文案。 */
  interface SessionWatchEntry {
    watchId: string | null;
    failed: boolean;
  }

  /**
   * sessionId → 当前 session 级观察通道的句柄（Task 16b）。`watchSession`
   * 调用时先登记一个 `watchId:null` 的句柄（REST 往返未完成的窗口期），
   * `startAgentWatch` 的 `onWatchId` 回调随后原地覆写该句柄的字段——
   * `confirm`/`answer` 回退取 watchId 必须每次现查这张表 + 现读句柄字段，
   * 不能捕获 `watchSession()` 调用瞬间的局部变量：REST 是异步的，观察者点
   * 确认这一刻 watchId 可能还没落地。
   *
   * 与 web-main 不同，本端当前实现里 REST 签发的 watchId 在 relay 断线重连
   * 时不换新（`RemoteWatchService.onRelayConnected` 原地复用同一个
   * watchId 重新上行 `agent.watch.start`，见该文件），但仍然经句柄间接读取
   * 「当前」值，不假设它这端不会变——保持与 web-main 同一读取纪律，避免
   * 未来该端实现变化（如补齐 idle 自动重连换新 id）时又要重新踩一次 T12
   * review Finding 2 的坑。
   */
  const sessionWatchEntries = new Map<string, SessionWatchEntry>();

  /**
   * `confirm`/`answer` 的寻址解析（Task 16b，逐字义同 web-main 同名函数）：
   * 有 streamId 优先用它；没有则回退该会话当前的 session 级 watchId；都没有
   * 才抛错，错误文案区分三种完全不同的排查线索——「从未发起过观察」
   * /「观察通道正在建立中（REST 往返尚未完成，正常等待窗口期，重试有意义）」
   * /「观察通道建立失败（Minor-1，T19b review：REST 永久失败，重试无意义，
   * 需引导用户刷新页面重新建立会话视图）」。
   */
  const resolveControlAddress = (
    streamId: string | null,
    sessionId: string,
  ): { streamId?: string; watchId?: string } => {
    if (streamId) return { streamId };
    const entry = sessionWatchEntries.get(sessionId);
    if (!entry) {
      throw new Error("远程会话 streamId 未就绪，请稍候重试");
    }
    if (entry.failed) {
      throw new Error("观察通道建立失败，请刷新页面重试");
    }
    if (!entry.watchId) {
      throw new Error("观察通道正在建立中，请稍候重试");
    }
    return { watchId: entry.watchId };
  };

  return {
    capabilities: { localRun: false },

    async listSessions() {
      return fetchRemoteSessions(agentId);
    },

    async fetchHistory(sessionId, opts) {
      return fetchRemoteHistory(agentId, sessionId, opts);
    },

    async startRun(input) {
      const { streamId } = await startRemoteRun(agentId, input);
      return { streamId };
    },

    async interrupt(streamId, sessionId) {
      // 中断**不**回退 watchId（T16 三处独立禁止，见 web-main 同名方法注释与
      // 本文件顶部契约层说明）：打断是破坏性操作、无从仲裁，观察者不可中断
      // 别人发起的 run。保持原样：无 streamId 只 warn + no-op，不抛错。
      if (!streamId) {
        console.warn(
          "远程会话当前无可用 streamId，无法中断（可能是刷新/直接进入一个仍在跑的远程会话）",
        );
        return;
      }
      await interruptRemoteRun(agentId, { streamId, sessionId });
    },

    async confirm(streamId, sessionId, toolCallId, decision, content) {
      await confirmRemote(agentId, {
        ...resolveControlAddress(streamId, sessionId),
        sessionId,
        toolCallId,
        decision,
        content,
      });
    },

    async answer(streamId, sessionId, toolCallId, answers) {
      await answerRemote(agentId, {
        ...resolveControlAddress(streamId, sessionId),
        sessionId,
        toolCallId,
        answers,
      });
    },

    async patchSessionModel(sessionId, modelConfigId) {
      await patchRemoteSessionModel(agentId, sessionId, modelConfigId);
    },

    async fetchPending(_sessionId) {
      // 远程 relay 无「排队未处理」语义（B 侧 appendMessage 直接落库/触发 run，
      // 没有本机 PendingMessage 表）——use-session-stream 只在 local 分支调用
      // 本方法，如实抛错而非伪造一个空列表掩盖误用。
      throw new Error(
        "远程会话不支持 pending 查询（SessionTransport.fetchPending 仅本地会话适用）",
      );
    },

    async fetchActiveRun(sessionId) {
      return fetchRemoteRun(agentId, { sessionId });
    },

    async readArtifact(sessionId, path) {
      return fetchRemoteArtifact(agentId, sessionId, path);
    },

    async uploadArtifactToDrive(sessionId, path) {
      return uploadRemoteArtifactToDrive(agentId, sessionId, path);
    },

    subscribe(events) {
      return bridgeSessionSocketEvents(events);
    },

    watchSession(sessionId) {
      // 登记进 sessionId → 句柄索引（Task 16b），供 confirm/answer 回退取
      // 「当前」watchId 用。先占位 watchId:null（REST 往返完成前的窗口期），
      // startAgentWatch 的 onWatchId 回调随后原地覆写这个句柄的字段；
      // onFailed 回调（Minor-1）原地置位 failed，供 resolveControlAddress
      // 区分「还没回来」与「永远不会回来」两种状态。
      const entry: SessionWatchEntry = { watchId: null, failed: false };
      sessionWatchEntries.set(sessionId, entry);
      const stop = startAgentWatch(
        agentId,
        "session",
        sessionId,
        (watchId) => {
          entry.watchId = watchId;
        },
        () => {
          entry.failed = true;
        },
      );
      return () => {
        // 同 sessionId 若被并发 watch 两次（如主视图 + IM dock 同时打开同一
        // 会话），后一次覆盖前一次登记——`sessionWatchEntries` 的当前值已经
        // 是后一次的 entry，本次 unwatch 只在自己仍是当前登记者时才摘除
        // 索引；各自的 stop() 仍会正常执行，互不影响真正的通道生命周期。
        //
        // 注意（Minor-2，T19b review 如实澄清）：这个等值判断只保护了「先
        // 挂后拆」的顺序（后一次覆盖登记后，先卸载的前一次不会误删它）；
        // 反过来「后一次先卸载」时，它的 unwatch 会摘掉当前仍指向自己的
        // 索引，而前一次（仍存活）的登记从此在表里彻底消失——不是没有这个
        // 缺口，是**今天不可达**：`sessionWatchEntries` 由每个视图各自的
        // `createRemoteSessionTransport()` 实例持有（`useMemo` per-view，
        // 见 `assistant-conversation-body.tsx` 的 transport 构造处），不同
        // 视图各自一张独立的表，同一 sessionId 不会在同一张表里被两次
        // `watchSession` 并发登记。若未来改成跨视图共享单例 transport，这
        // 里需要换成插入序 / 引用计数才能补上这个缺口。
        if (sessionWatchEntries.get(sessionId) === entry) {
          sessionWatchEntries.delete(sessionId);
        }
        stop();
      };
    },

    // `onEvent` 有意不使用——见 `startAgentWatch` 文档：web-agent 的 Agent
    // 级生命周期事件走全局事件总线（`use-global-events.ts`），不经这条
    // per-transport-instance 回调路径。
    watchAgent(_onEvent) {
      return startAgentWatch(agentId, "agent");
    },
  };
}
