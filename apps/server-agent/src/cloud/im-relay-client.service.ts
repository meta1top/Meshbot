import { AccountContextService } from "@meshbot/lib-agent";
import { AppError } from "@meshbot/common";
import { IM_WS_EVENTS, IM_WS_NAMESPACE } from "@meshbot/types";
import type {
  AgentRunControlForwarded,
  AgentRunControlInput,
  AgentRunEnd,
  AgentRunFrame,
  AgentRunStartForwarded,
  AgentRunStartInput,
  DeviceQueryForwarded,
  DeviceQueryRequestInput,
  DeviceQueryResponse,
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
import {
  IM_RELAY_EVENTS,
  type ImRelayConnectedEvent,
  type ImRelayModelConfigChangedEvent,
} from "./im-relay.events";
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

/** 被服务端主动踢后的手动补连延迟（socket.io 对 io server disconnect 不自动重连）。 */
const KICKED_RECONNECT_DELAY_MS = 3_000;

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
   * 在 0↔1 跳变时调 setUiPresence 维护。决定 relay（重）连后是否重新上报「用户」
   * 在线态（presence_set）。注意：不再门控 keepalive ping——设备连着 server-main
   * 就无条件周期 ping 续期设备级 presence（headless agent 无浏览器仍需在线）。
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
   * 若该账号未登录（无 deviceToken）或无活跃 org（orgId 为 null）→ 跳过，不建连接。
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

      // org 模型配置变更（云端广播的失效信号）→ 桥给 CloudModelConfigProxyService（清缓存）。
      socket.on(IM_WS_EVENTS.modelConfigChanged, () => {
        this.account.run(cloudUserId, () => {
          this.emitter.emit(IM_RELAY_EVENTS.modelConfigChanged, {
            cloudUserId,
          } satisfies ImRelayModelConfigChangedEvent);
        });
      });

      // L2c 下行：设备查询响应（B→云→A）→ 桥给 RemoteDeviceQueryService.settle。
      socket.on(
        IM_WS_EVENTS.deviceQueryResponse,
        (payload: DeviceQueryResponse) => {
          this.account.run(cloudUserId, () => {
            this.emitter.emit(IM_RELAY_EVENTS.deviceQueryResponse, payload);
          });
        },
      );
      // L2c 下行：入站设备查询请求（云端转发到本设备）→ 供 Task4 入站消费。
      socket.on(
        IM_WS_EVENTS.deviceQueryRequest,
        (payload: DeviceQueryForwarded) => {
          this.account.run(cloudUserId, () => {
            this.emitter.emit(IM_RELAY_EVENTS.deviceQueryRequest, {
              cloudUserId,
              forwarded: payload,
            });
          });
        },
      );

      // L3 下行：入站远程 run 请求（云端转发到本设备，本设备作为 B）→ 供 Task4 入站消费。
      socket.on(
        IM_WS_EVENTS.agentRunStart,
        (payload: AgentRunStartForwarded) => {
          this.account.run(cloudUserId, () => {
            this.emitter.emit(IM_RELAY_EVENTS.agentRunRequest, {
              cloudUserId,
              forwarded: payload,
            });
          });
        },
      );
      // L3 下行：入站运行控制指令（云端转发到本设备，本设备作为 B）→ 供 Task5 入站消费。
      socket.on(
        IM_WS_EVENTS.agentRunControl,
        (payload: AgentRunControlForwarded) => {
          this.account.run(cloudUserId, () => {
            this.emitter.emit(IM_RELAY_EVENTS.agentRunControlInbound, {
              cloudUserId,
              forwarded: payload,
            });
          });
        },
      );
      // L3 下行：云端回流的运行帧（B→云→A，本设备作为发起方 A）→ 桥给 RemoteRunService.onFrame。
      socket.on(IM_WS_EVENTS.agentRunFrame, (payload: AgentRunFrame) => {
        this.account.run(cloudUserId, () => {
          this.emitter.emit(IM_RELAY_EVENTS.agentRunFrame, payload);
        });
      });
      // L3 下行：云端回流的流终止通知（B→云→A，本设备作为发起方 A）→ 桥给 RemoteRunService.onEnd。
      socket.on(IM_WS_EVENTS.agentRunEnd, (payload: AgentRunEnd) => {
        this.account.run(cloudUserId, () => {
          this.emitter.emit(IM_RELAY_EVENTS.agentRunEnd, payload);
        });
      });

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

      // 服务端主动踢（onAuthedConnect 失败 / 重启窗口内被 disconnect(true)）时
      // socket.io 协议约定客户端不自动重连（reason = "io server disconnect"），
      // 必须手动补连，否则 relay 永久断、设备在云端一直离线。延迟补连避免撞
      // 服务端 boot 窗口形成快速踢-连循环；补连前确认该账号连接仍在册
      //（期间登出拆连则不复活）。其余 reason 由 socket.io 自动重连，不干预。
      socket.on("disconnect", (reason: string) => {
        if (reason !== "io server disconnect") return;
        const timer = setTimeout(() => {
          if (this.conns.get(cloudUserId)?.socket === socket) {
            socket.connect();
          }
        }, KICKED_RECONNECT_DELAY_MS);
        // biome-ignore lint/suspicious/noExplicitAny: NodeJS.Timeout has unref()
        (timer as any).unref?.();
      });

      // relay（重）连成功后：若该账号仍有浏览器连着，重新上报在线
      //（覆盖初次建连竞态 + 网络抖动重连——presence 由浏览器驱动，需重连后重断言）。
      socket.on("connect", () => {
        if (this.uiOnline.has(cloudUserId)) {
          socket.emit(IM_WS_EVENTS.presenceSet, {
            online: true,
          } satisfies ImPresenceSetInput);
        }
        this.account.run(cloudUserId, () => {
          this.emitter.emit(IM_RELAY_EVENTS.connected, {
            cloudUserId,
          } satisfies ImRelayConnectedEvent);
        });
      });

      // keepalive ping：只要 socket 连着就无条件周期发（设备连着 server-main 就该
      // 持续续期设备级 presence——headless agent 无浏览器也要维持在线态，故不再门控于
      // uiOnline；uiOnline 语义只保留给"用户浏览器在线态"presence_set 上报）。
      // unref 防止阻塞进程退出。
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

  /**
   * L2c：发起跨设备只读查询（上行，按账号）。
   *
   * @throws {AppError} IM_NOT_CONNECTED — 该账号未建立连接时抛出。
   */
  emitDeviceQuery(cloudUserId: string, payload: DeviceQueryRequestInput): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) {
      throw new AppError(AgentErrorCode.IM_NOT_CONNECTED);
    }
    conn.socket.emit(IM_WS_EVENTS.deviceQueryRequest, payload);
  }

  /**
   * L2c：B 侧回发查询响应（上行，按账号；best-effort，未连接时静默跳过——
   * 发起方已由自身超时兜底，不需要 B 侧再抛错）。
   */
  emitDeviceQueryResponse(
    cloudUserId: string,
    payload: DeviceQueryResponse,
  ): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) return;
    conn.socket.emit(IM_WS_EVENTS.deviceQueryResponse, payload);
  }

  /**
   * L3 A 侧：发起跨设备远程 run（上行，按账号）。
   *
   * @throws {AppError} IM_NOT_CONNECTED — 该账号未建立连接时抛出。
   */
  emitAgentRunStart(cloudUserId: string, payload: AgentRunStartInput): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) {
      throw new AppError(AgentErrorCode.IM_NOT_CONNECTED);
    }
    conn.socket.emit(IM_WS_EVENTS.agentRunStart, payload);
  }

  /**
   * L3 A 侧：下发运行中控制指令（confirm/answer/interrupt，上行，按账号）。
   *
   * @throws {AppError} IM_NOT_CONNECTED — 该账号未建立连接时抛出。
   */
  emitAgentRunControl(
    cloudUserId: string,
    payload: AgentRunControlInput,
  ): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) {
      throw new AppError(AgentErrorCode.IM_NOT_CONNECTED);
    }
    conn.socket.emit(IM_WS_EVENTS.agentRunControl, payload);
  }

  /**
   * L3 B 侧：回发运行帧（上行，按账号；best-effort，未连接静默跳过——
   * 发起方 A 由自身 idle 超时兜底，不需要 B 侧再抛错）。
   */
  emitAgentRunFrame(cloudUserId: string, payload: AgentRunFrame): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) return;
    conn.socket.emit(IM_WS_EVENTS.agentRunFrame, payload);
  }

  /**
   * L3 B 侧：回发流终止通知（上行，按账号；best-effort，理由同上）。
   */
  emitAgentRunEnd(cloudUserId: string, payload: AgentRunEnd): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) return;
    conn.socket.emit(IM_WS_EVENTS.agentRunEnd, payload);
  }
}
