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
  fetchRemoteSessions,
  interruptRemoteRun,
  patchRemoteSessionModel,
  startRemoteRun,
  uploadRemoteArtifactToDrive,
} from "@/rest/remote-devices";
import {
  appendMessage,
  confirmAnswers,
  confirmSend,
  fetchHistory,
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
      const messageId = clientSnowflakeId();
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
      // remote-devices 的 upload-drive 查询通道给跨设备场景用；本地预览走
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
 * A 端远程会话 SessionTransport：包 `rest/remote-devices.ts` 十个函数 +
 * 复用同一条本机 `ws/session` socket 做事件桥（B 的运行帧经服务端影子重发
 * 落在这条 socket 上，前端无需另开连接）。
 */
export function createRemoteSessionTransport(
  deviceId: string,
): SessionTransport {
  return {
    capabilities: { localRun: false },

    async listSessions() {
      return fetchRemoteSessions(deviceId);
    },

    async fetchHistory(sessionId, opts) {
      return fetchRemoteHistory(deviceId, sessionId, opts);
    },

    async startRun(input) {
      const { streamId } = await startRemoteRun(deviceId, input);
      return { streamId };
    },

    async interrupt(streamId, sessionId) {
      if (!streamId) {
        console.warn(
          "远程会话当前无可用 streamId，无法中断（可能是刷新/直接进入一个仍在跑的远程会话）",
        );
        return;
      }
      await interruptRemoteRun(deviceId, { streamId, sessionId });
    },

    async confirm(streamId, sessionId, toolCallId, decision, content) {
      if (!streamId) {
        throw new Error("远程会话 streamId 未就绪，请稍候重试");
      }
      await confirmRemote(deviceId, {
        streamId,
        sessionId,
        toolCallId,
        decision,
        content,
      });
    },

    async answer(streamId, sessionId, toolCallId, answers) {
      if (!streamId) {
        throw new Error("远程会话 streamId 未就绪，请稍候重试");
      }
      await answerRemote(deviceId, {
        streamId,
        sessionId,
        toolCallId,
        answers,
      });
    },

    async patchSessionModel(sessionId, modelConfigId) {
      await patchRemoteSessionModel(deviceId, sessionId, modelConfigId);
    },

    async readArtifact(sessionId, path) {
      return fetchRemoteArtifact(deviceId, sessionId, path);
    },

    async uploadArtifactToDrive(sessionId, path) {
      return uploadRemoteArtifactToDrive(deviceId, sessionId, path);
    },

    subscribe(events) {
      return bridgeSessionSocketEvents(events);
    },
  };
}
