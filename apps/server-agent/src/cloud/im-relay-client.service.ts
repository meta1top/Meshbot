import { AppError } from "@meshbot/common";
import { IM_WS_EVENTS } from "@meshbot/types";
import type { ImReadInput, ImSendInput } from "@meshbot/types";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { type Socket, io } from "socket.io-client";

import { AgentErrorCode } from "../errors/agent.error-codes";
import type { CloudIdentityService } from "../services/cloud-identity.service";

/** socket.io-client 工厂函数类型（方便测试注入伪实现）。 */
type IoFactory = (url: string, opts: Parameters<typeof io>[1]) => Socket;

/**
 * 云端 IM WebSocket 中继客户端。
 *
 * server-agent 持有此服务的唯一长连接（指向 server-main `ws/im`），
 * 将所有下行 IM 事件转发到本地 EventEmitter2 总线——Phase 3 的 Agent 监听钩子。
 *
 * Task 4.1 中性化：CloudIdentity 改为多行（PK=cloud_user_id），旧的单行 `connect()`
 * 已失效，boot 自动连接被移除。Task 3.6 会重建为按账号 `connect(cloudUserId)`。
 * 当前 `connect()` 为 no-op，仅保留 disconnect/send/read/isConnected 行为。
 *
 * - `disconnect()`：登出 / 强制断开时调用（socket 为 null 时安全 no-op）。
 * - `send()` / `read()`：上行消息；未连接时 send 抛 IM_NOT_CONNECTED。
 */
@Injectable()
export class ImRelayClientService implements OnModuleDestroy {
  private socket: Socket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // Task 3.6 中性化期间，下列依赖暂未被 connect() 使用，但保留以供 3.6 按账号重建连接。
  constructor(
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: 保留供 Task 3.6 按账号 connect 使用
    private readonly cloudIdentityService: CloudIdentityService,
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: 保留供 Task 3.6 下行事件转发使用
    private readonly emitter: EventEmitter2,
    /**
     * 云端 WS URL，默认从 ConfigService 读取 `MESHBOT_CLOUD_URL`。
     * 直接传字符串供测试使用（与 CloudClientService 构造函数同构）。
     */
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: 保留供 Task 3.6 建连使用
    private readonly cloudWsUrl: string | ConfigService,
    /** socket.io-client io 函数；测试可注入伪实现。 */
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: 保留供 Task 3.6 建连使用
    private readonly ioFactory: IoFactory = io as unknown as IoFactory,
  ) {}

  /**
   * 建立到云端 `ws/im` 的持久连接。
   *
   * Task 3.6: 改为按账号 connect(cloudUserId)；当前中性化为 no-op。
   */
  async connect(): Promise<void> {
    // Task 3.6: 改为按账号 connect(cloudUserId)；当前中性化
    return;
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
