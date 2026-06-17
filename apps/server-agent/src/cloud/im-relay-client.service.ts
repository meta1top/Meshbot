import { AccountContextService } from "@meshbot/agent";
import { AppError } from "@meshbot/common";
import { IM_WS_EVENTS, IM_WS_NAMESPACE } from "@meshbot/types";
import type { ImReadInput, ImSendInput } from "@meshbot/types";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { type Socket, io } from "socket.io-client";

import { AgentErrorCode } from "../errors/agent.error-codes";
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
 * 每个已登录账号持有自己的独立云连接（各自的 cloudToken），指向 server-main
 * `ws/im`，将所有下行 IM 事件转发到本地 EventEmitter2 总线——Agent 监听钩子。
 *
 * - `connect(cloudUserId)`：读该账号 cloud_identity；无 token 或无活跃 org → 静默跳过；幂等。
 * - `disconnect(cloudUserId)`：登出 / 强制断开时调用；幂等。
 * - `send()` / `read()`：上行消息（按账号）；未连接时 send 抛 IM_NOT_CONNECTED。
 * - 401 等认证失败（`connect_error`）→ 拆该账号 socket + 置该账号 loggedOut。
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
      if (!identity?.cloudToken || !identity.orgId) {
        return;
      }

      const baseUrl =
        typeof this.cloudWsUrl === "string"
          ? this.cloudWsUrl
          : this.cloudWsUrl.getOrThrow<string>("MESHBOT_CLOUD_URL");

      const url = `${baseUrl}/${IM_WS_NAMESPACE}`;

      const socket = this.ioFactory(url, {
        auth: { token: identity.cloudToken },
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
      ] as const) {
        socket.on(event, (payload: unknown) => {
          this.account.run(cloudUserId, () => {
            this.emitter.emit(event, payload);
          });
        });
      }

      // connect_error：认证失败 → 拆该账号 socket 防僵尸/重连风暴，再置该账号 loggedOut
      socket.on("connect_error", (err: Error) => {
        const msg = err?.message?.toLowerCase() ?? "";
        if (msg.includes("unauthorized")) {
          this.disconnect(cloudUserId);
          void this.cloudIdentityService.setLoggedOut(cloudUserId);
        }
      });

      // keepalive ping（unref 防止阻塞进程退出）
      const timer = setInterval(() => {
        if (socket.connected) {
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
