import { AccountContextService } from "@meshbot/agent";
import { AppError } from "@meshbot/common";
import { IM_WS_EVENTS, IM_WS_NAMESPACE } from "@meshbot/types";
import type {
  ImPresenceSetInput,
  ImReadInput,
  ImSendInput,
  PresenceState,
} from "@meshbot/types";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { type Socket, io } from "socket.io-client";

import { AgentErrorCode } from "../errors/agent.error-codes";
import { AUTH_EVENTS } from "../services/auth.events";
import type { CloudIdentityService } from "../services/cloud-identity.service";

/** socket.io-client 工厂函数类型（方便测试注入伪实现）。 */
type IoFactory = (url: string, opts: Parameters<typeof io>[1]) => Socket;

/** 单个账号的云连接状态。 */
interface Conn {
  socket: Socket;
  pingTimer: ReturnType<typeof setInterval> | null;
}

/** keepalive 心跳间隔（ms）。 */
const PING_INTERVAL_MS = 20_000;

/**
 * 云端 IM WebSocket 中继客户端（v3 账号化）。
 *
 * 每个已登录账号持有自己的独立云连接（各自的 deviceToken），指向 server-main
 * `ws/im`，将所有下行 IM 事件转发到本地 EventEmitter2 总线——Agent 监听钩子。
 *
 * - `connect(cloudUserId)`：读该账号 cloud_identity；无 token 或无活跃 org → 静默跳过；幂等。
 * - `disconnect(cloudUserId)`：登出 / 强制断开时调用；幂等。
 * - `send()` / `read()`：上行消息（按账号）；未连接时 send 抛 IM_NOT_CONNECTED。
 * - 401 等认证失败（`connect_error`）→ 拆该账号 socket + 置该账号 loggedOut + 发
 *   `AUTH_EVENTS.reauthRequired`（供 EventsGateway 转发前端提示重新授权）。
 * - keepalive：连接后每 ~20s 发一次 `im.ping`，刷新服务端 presence TTL。
 *
 * 连接由运行时注册表 / 登录驱动（无 onModuleInit；boot 不自动建连）。
 */
@Injectable()
export class ImRelayClientService implements OnModuleDestroy {
  /** 账号 → 云连接（cloudUserId 为键）。 */
  private readonly conns = new Map<string, Conn>();
  /** 正在建连的账号（防并发重复建连）。 */
  private readonly connecting = new Set<string>();
  /**
   * 每账号当前已知的对端在线状态（cloudUserId → peerUserId → online）。
   * 由下行 im.presence 维护（含 server-main 在 relay 连接时下发的初始在线快照）；
   * 供浏览器晚于 relay 连上 ws/events 时回放在线快照（修「对端一直显示离线」）。
   */
  private readonly presence = new Map<string, Map<string, boolean>>();

  /**
   * 「有浏览器连着」的账号集合（cloudUserId）。由 EventsGateway 按浏览器连接数
   * 在 0↔1 跳变时调 setUiPresence 维护。决定：① 是否 ping（无浏览器不续期 TTL）
   * ② relay 重连后是否重新上报在线。
   */
  private readonly uiOnline = new Set<string>();

  constructor(
    private readonly cloudIdentityService: CloudIdentityService,
    private readonly emitter: EventEmitter2,
    /**
     * 云端 WS URL，默认从 ConfigService 读取 `MESHBOT_CLOUD_URL`。
     * 直接传字符串供测试使用（与 CloudClientService 构造函数同构）。
     */
    private readonly cloudWsUrl: string | ConfigService,
    /** 账号上下文服务；下行事件 emit 包裹在对应账号的 AsyncLocalStorage 上下文内。 */
    private readonly account: AccountContextService,
    /** socket.io-client io 函数；测试可注入伪实现。 */
    private readonly ioFactory: IoFactory = io as unknown as IoFactory,
  ) {}

  /**
   * 为指定账号建立到云端 `ws/im` 的持久连接。
   *
   * 若该账号未登录（无 cloudToken）或无活跃 org（orgId 为 null）→ 跳过，不建连接。
   * 已连接或正在建连时直接返回（幂等）。
   */
  async connect(cloudUserId: string): Promise<void> {
    if (this.conns.has(cloudUserId) || this.connecting.has(cloudUserId)) {
      return; // 已连接或正在建连，避免重复建立
    }
    this.connecting.add(cloudUserId);
    try {
      const identity = await this.cloudIdentityService.get(cloudUserId);
      if (!identity?.deviceToken || !identity.orgId) {
        return;
      }

      const baseUrl =
        typeof this.cloudWsUrl === "string"
          ? this.cloudWsUrl
          : this.cloudWsUrl.getOrThrow<string>("MESHBOT_CLOUD_URL");

      const url = `${baseUrl}/${IM_WS_NAMESPACE}`;

      const socket = this.ioFactory(url, {
        auth: { token: identity.deviceToken },
        transports: ["websocket"],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10_000,
      });

      // 下行事件 → 本地 EventEmitter2（Agent 钩子）
      for (const event of [
        IM_WS_EVENTS.message,
        IM_WS_EVENTS.presence,
        IM_WS_EVENTS.conversationCreated,
        IM_WS_EVENTS.conversationRemoved,
        IM_WS_EVENTS.conversationRead,
      ] as const) {
        socket.on(event, (payload: unknown) => {
          if (event === IM_WS_EVENTS.presence) {
            this.cachePresence(cloudUserId, payload as PresenceState);
          }
          this.account.run(cloudUserId, () => {
            this.emitter.emit(event, payload);
          });
        });
      }

      // connect_error：认证失败 → 拆该账号 socket 防僵尸/重连风暴，置该账号 loggedOut，
      // 并发重授权事件（account.run 包裹，供 EventsGateway 路由到该账号 acct 房间）。
      socket.on("connect_error", (err: Error) => {
        const msg = err?.message?.toLowerCase() ?? "";
        if (msg.includes("unauthorized")) {
          this.disconnect(cloudUserId);
          void this.cloudIdentityService.setLoggedOut(cloudUserId);
          this.account.run(cloudUserId, () => {
            this.emitter.emit(AUTH_EVENTS.reauthRequired, { cloudUserId });
          });
        }
      });

      // relay（重）连成功后：若该账号仍有浏览器连着，重新上报在线
      //（覆盖初次建连竞态 + 网络抖动重连——presence 由浏览器驱动，需重连后重断言）。
      socket.on("connect", () => {
        if (this.uiOnline.has(cloudUserId)) {
          socket.emit(IM_WS_EVENTS.presenceSet, {
            online: true,
          } satisfies ImPresenceSetInput);
        }
      });

      // keepalive ping（无浏览器时不续期 TTL；unref 防止阻塞进程退出）
      const timer = setInterval(() => {
        if (socket.connected && this.uiOnline.has(cloudUserId)) {
          socket.emit(IM_WS_EVENTS.ping);
        }
      }, PING_INTERVAL_MS);
      // biome-ignore lint/suspicious/noExplicitAny: NodeJS.Timeout has unref()
      (timer as any).unref?.();

      this.conns.set(cloudUserId, { socket, pingTimer: timer });
    } finally {
      this.connecting.delete(cloudUserId);
    }
  }

  /** NestJS 模块销毁时断开所有账号连接并清理定时器。 */
  onModuleDestroy(): void {
    for (const id of [...this.conns.keys()]) {
      this.disconnect(id);
    }
  }

  /** 断开并清理指定账号的连接（登出时调用）；幂等。 */
  disconnect(cloudUserId: string): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn) {
      return;
    }
    if (conn.pingTimer !== null) {
      clearInterval(conn.pingTimer);
    }
    conn.socket.disconnect();
    this.conns.delete(cloudUserId);
    this.presence.delete(cloudUserId);
    this.uiOnline.delete(cloudUserId);
  }

  /** 记录某账号视角下对端的在线状态（下行 im.presence 维护本地快照缓存）。 */
  private cachePresence(cloudUserId: string, state: PresenceState): void {
    let m = this.presence.get(cloudUserId);
    if (!m) {
      m = new Map<string, boolean>();
      this.presence.set(cloudUserId, m);
    }
    m.set(state.userId, state.online);
  }

  /** 该账号当前已知在线的对端 userId 列表（供浏览器连上 ws/events 时回放在线快照）。 */
  getOnlinePeers(cloudUserId: string): string[] {
    const m = this.presence.get(cloudUserId);
    if (!m) return [];
    const out: string[] = [];
    for (const [userId, online] of m) {
      if (online) out.push(userId);
    }
    return out;
  }

  /**
   * 浏览器在线态变更（EventsGateway 在某账号浏览器连接数 0↔1 跳变时调）。
   * 记录 uiOnline（门控 ping + relay 重连重断言），并立即上报 server-main。
   * 未连接时静默（relay 连上后 connect 监听会重断言 online）。
   */
  setUiPresence(cloudUserId: string, online: boolean): void {
    if (online) {
      this.uiOnline.add(cloudUserId);
    } else {
      this.uiOnline.delete(cloudUserId);
    }
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) return;
    conn.socket.emit(IM_WS_EVENTS.presenceSet, {
      online,
    } satisfies ImPresenceSetInput);
  }

  /**
   * 发送 IM 消息（上行，按账号）。
   *
   * @throws {AppError} IM_NOT_CONNECTED — 该账号未建立连接时抛出。
   */
  send(cloudUserId: string, input: ImSendInput): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) {
      throw new AppError(AgentErrorCode.IM_NOT_CONNECTED);
    }
    conn.socket.emit(IM_WS_EVENTS.send, input);
  }

  /**
   * 标记消息已读（上行，按账号；best-effort，未连接时静默跳过）。
   */
  read(cloudUserId: string, input: ImReadInput): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) return;
    conn.socket.emit(IM_WS_EVENTS.read, input);
  }

  /** 指定账号当前是否有活跃连接。 */
  isConnected(cloudUserId: string): boolean {
    return this.conns.get(cloudUserId)?.socket.connected === true;
  }
}
