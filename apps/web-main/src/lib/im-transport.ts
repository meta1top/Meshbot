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
import { disconnectImSocket, getImSocket } from "./im-socket";

/** server-agent 每 ~20s 发一次 ping 续期 presence TTL（45s）；web-main 无 relay，自己按同频率续。 */
const PING_INTERVAL_MS = 20_000;

/** keepalive 定时器句柄：`resetMainImTransport()` 重建 transport 前清掉旧的，
 * 避免每次切组织重建都新开一个永不停止的 zombie interval（旧 socket 已断连，
 * 定时器里的 `socket.connected` 判断永远为 false，但定时器本身仍会一直触发）。 */
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

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

  // 每次（重）连接成功都重新上报在线（对齐 im-relay-client.service.ts 的 connect 处理：
  // 覆盖首次建连竞态 + 断线重连场景）。构建时 socket 可能已处于连接态（单例复用场景，
  // 例如先访问 /settings/devices 再切 /messages）：同一 onConnect 立即补跑一次
  //（照 use-global-events.ts 的 `if (socket.connected) onConnect()` 先例），
  // 而非只在 "connect" 事件回调里处理，否则永远等不到这次事件。
  const onConnect = () => {
    socket.emit(IM_WS_EVENTS.presenceSet, { online: true });
  };
  socket.on("connect", onConnect);
  if (socket.connected) onConnect();

  // keepalive：定时器构建时无条件启动（不依赖 "connect" 事件回调触发），避免
  // transport 构建时 socket 已连接导致定时器永不启动、45s presence TTL 到期后
  // 在线态熄灭；回调内判断 socket.connected 才真正发送 ping（对齐
  // im-relay-client.service.ts 的 keepalive 模式）。transport 随浏览器 tab 内
  // 一次「登录会话」常驻，但会因切组织被 `resetMainImTransport()` 重建
  // （见下），故构建前先清掉上一份定时器，防止旧句柄常驻。
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = setInterval(() => {
    if (socket.connected) {
      socket.emit(IM_WS_EVENTS.ping);
    }
  }, PING_INTERVAL_MS);

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

/** 断开并清空当前 transport 单例（socket + keepalive 定时器 + 缓存的事件桥/presence）；
 * 切组织后调用，否则旧 socket 停在旧 org 房间、会话列表不会跟着刷新。
 * 调用后 `createMainImTransport()` 会用当下的浏览器 token（已重签为新组织）重建一份全新连接。 */
export function resetMainImTransport(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  disconnectImSocket();
  cached = null;
}
