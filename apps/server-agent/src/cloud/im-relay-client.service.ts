import { AppError } from "@meshbot/common";
import { IM_WS_EVENTS, IM_WS_NAMESPACE } from "@meshbot/types";
import type { ImReadInput, ImSendInput } from "@meshbot/types";
import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { type Socket, io } from "socket.io-client";

import { AgentErrorCode } from "../errors/agent.error-codes";
import type { CloudIdentityService } from "../services/cloud-identity.service";

/** socket.io-client 工厂函数类型（方便测试注入伪实现）。 */
type IoFactory = (url: string, opts: Parameters<typeof io>[1]) => Socket;

/** keepalive 心跳间隔（ms）。 */
const PING_INTERVAL_MS = 20_000;

/**
 * 云端 IM WebSocket 中继客户端。
 *
 * server-agent 持有此服务的唯一长连接（指向 server-main `ws/im`），
 * 将所有下行 IM 事件转发到本地 EventEmitter2 总线——Phase 3 的 Agent 监听钩子。
 *
 * - `connect()`：读 cloud_identity；无 token 或无活跃 org → 静默跳过。
 * - `disconnect()`：登出 / 强制断开时调用。
 * - `send()` / `read()`：上行消息；未连接时 send 抛 IM_NOT_CONNECTED。
 * - 401 等认证失败（`connect_error`）→ 清 cloud_identity，复现 CloudClient 语义。
 * - keepalive：连接后每 ~20s 发一次 `im.ping`，刷新服务端 presence TTL。
 */
@Injectable()
export class ImRelayClientService implements OnModuleInit, OnModuleDestroy {
  private socket: Socket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connecting = false;

  constructor(
    private readonly cloudIdentityService: CloudIdentityService,
    private readonly emitter: EventEmitter2,
    /**
     * 云端 WS URL，默认从 ConfigService 读取 `MESHBOT_CLOUD_URL`。
     * 直接传字符串供测试使用（与 CloudClientService 构造函数同构）。
     */
    private readonly cloudWsUrl: string | ConfigService,
    /** socket.io-client io 函数；测试可注入伪实现。 */
    private readonly ioFactory: IoFactory = io as unknown as IoFactory,
  ) {}

  /**
   * 建立到云端 `ws/im` 的持久连接。
   *
   * 若未登录（无 cloudToken）或无活跃 org（orgId 为 null）→ 跳过，不建连接。
   */
  async connect(): Promise<void> {
    if (this.socket || this.connecting) {
      return; // 已连接或正在建连，避免重复建立
    }
    this.connecting = true;
    try {
      const identity = await this.cloudIdentityService.get();
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
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10_000,
      });

      this.socket = socket;

      // 下行事件 → 本地 EventEmitter2（Phase 3 钩子）
      for (const event of [
        IM_WS_EVENTS.message,
        IM_WS_EVENTS.presence,
        IM_WS_EVENTS.conversationCreated,
      ] as const) {
        socket.on(event, (payload: unknown) => {
          this.emitter.emit(event, payload);
        });
      }

      // connect_error：认证失败 → 先拆 socket 防僵尸/重连风暴，再清 cloud_identity
      socket.on("connect_error", (err: Error) => {
        const msg = err?.message?.toLowerCase() ?? "";
        if (msg.includes("unauthorized")) {
          this.disconnect();
          void this.cloudIdentityService.clear();
        }
      });

      // keepalive ping（unref 防止阻塞进程退出）
      const timer = setInterval(() => {
        if (this.socket?.connected) {
          this.socket.emit("im.ping");
        }
      }, PING_INTERVAL_MS);
      // biome-ignore lint/suspicious/noExplicitAny: NodeJS.Timeout has unref()
      (timer as any).unref?.();
      this.pingTimer = timer;
    } finally {
      this.connecting = false;
    }
  }

  /**
   * NestJS 模块初始化时自动尝试连接（启动即连）。
   * 若未登录或无活跃 org，connect() 内部静默跳过，safe to call unconditionally。
   */
  onModuleInit(): void {
    void this.connect();
  }

  /** NestJS 模块销毁时自动清理 socket 和定时器。 */
  onModuleDestroy(): void {
    this.disconnect();
  }

  /** 断开并清理连接（登出时调用）。 */
  disconnect(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * 发送 IM 消息（上行）。
   *
   * @throws {AppError} IM_NOT_CONNECTED — 未建立连接时抛出。
   */
  send(input: ImSendInput): void {
    if (!this.socket?.connected) {
      throw new AppError(AgentErrorCode.IM_NOT_CONNECTED);
    }
    this.socket.emit(IM_WS_EVENTS.send, input);
  }

  /**
   * 标记消息已读（best-effort，不连接时静默跳过）。
   */
  read(input: ImReadInput): void {
    if (!this.socket?.connected) return;
    this.socket.emit(IM_WS_EVENTS.read, input);
  }

  /** 当前是否有活跃连接。 */
  isConnected(): boolean {
    return this.socket?.connected === true;
  }
}
