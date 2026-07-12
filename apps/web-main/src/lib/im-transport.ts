import type {
  ChannelMember,
  ConversationSummary,
  ImMessage,
} from "@meshbot/types";
import { IM_WS_EVENTS } from "@meshbot/types";
import {
  bridgeImSocketEvents,
  ImEventHub,
  type ImTransport,
  type ImTransportEvents,
  PresenceCache,
} from "@meshbot/web-common/im";
import { mainApi } from "./api";
import { getImSocket } from "./im-socket";

/** server-agent 每 ~20s 发一次 ping 续期 presence TTL（45s）；web-main 无 relay，自己按同频率续。 */
const PING_INTERVAL_MS = 20_000;

/**
 * web-main 云协同前端的 `ImTransport` 实现：REST 直连 server-main `ImController`
 * （`mainApi`，Bearer 浏览器 JWT）+ WS 直连 `ws/im`（`getImSocket()` 单例）。
 *
 * presence 语义（对齐 `ImGateway` 注释）：连接建立不自动上线，需显式
 * `im.presence_set`；web-main 没有 server-agent 那样的 relay 层按浏览器连接数
 * 聚合上报，故本适配器自己在 socket 连接成功后上报一次「在线」+ 之后每
 * ~20s ping 续期，断线由服务端 `handleDisconnect` 兜底下线，无需显式上报离线。
 */
function buildMainImTransport(): ImTransport {
  const socket = getImSocket();
  const hub = new ImEventHub();
  const presenceCache = new PresenceCache();

  bridgeImSocketEvents(socket, hub, presenceCache);

  let pingTimer: ReturnType<typeof setInterval> | null = null;
  const stopPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };
  socket.on("connect", () => {
    socket.emit(IM_WS_EVENTS.presenceSet, { online: true });
    stopPing();
    pingTimer = setInterval(() => {
      socket.emit(IM_WS_EVENTS.ping);
    }, PING_INTERVAL_MS);
  });
  socket.on("disconnect", stopPing);
  // 创建时 socket 可能已处于连接态（单例复用场景）：补发一次上线上报。
  if (socket.connected) {
    socket.emit(IM_WS_EVENTS.presenceSet, { online: true });
  }

  return {
    listConversations: async () =>
      (await mainApi.get<ConversationSummary[]>("/api/conversations")).data,

    listMessages: async (conversationId, opts) => {
      const params = new URLSearchParams();
      if (opts?.before) params.set("before", opts.before);
      if (opts?.limit) params.set("limit", String(opts.limit));
      const qs = params.toString();
      return (
        await mainApi.get<{ messages: ImMessage[]; hasMore: boolean }>(
          `/api/conversations/${conversationId}/messages${qs ? `?${qs}` : ""}`,
        )
      ).data;
    },

    send: async (conversationId, content) => {
      socket.emit(IM_WS_EVENTS.send, { conversationId, content });
    },

    markRead: async (conversationId) => {
      socket.emit(IM_WS_EVENTS.read, { conversationId });
    },

    createDm: async (userId) =>
      (await mainApi.post<ConversationSummary>("/api/dms", { userId })).data,

    createChannel: async (name, memberIds, visibility = "public") =>
      (
        await mainApi.post<ConversationSummary>("/api/channels", {
          name,
          visibility,
          memberIds: memberIds.length > 0 ? memberIds : undefined,
        })
      ).data,

    addChannelMember: async (conversationId, userId) => {
      await mainApi.post<ConversationSummary>(
        `/api/channels/${conversationId}/members`,
        { userId },
      );
    },

    leaveChannel: async (conversationId) => {
      await mainApi.delete<{ ok: true }>(
        `/api/channels/${conversationId}/members/me`,
      );
    },

    listChannelMembers: async (conversationId) =>
      (
        await mainApi.get<ChannelMember[]>(
          `/api/channels/${conversationId}/members`,
        )
      ).data,

    subscribe: (events: Partial<ImTransportEvents>) => hub.on(events),

    presenceSnapshot: () => presenceCache.snapshot(),
  };
}

let cached: ImTransport | null = null;

/** 取（并按需建立）web-main 的 `ImTransport` 单例；同进程内复用同一份事件桥 + presence 缓存。 */
export function createMainImTransport(): ImTransport {
  if (!cached) cached = buildMainImTransport();
  return cached;
}
