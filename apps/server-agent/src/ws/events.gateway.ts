import {
  AppError,
  BaseWebSocketGateway,
  CommonErrorCode,
  WsAuthGuard,
  WsExceptionFilter,
} from "@meshbot/common";
import {
  AUTH_WS_EVENTS,
  EVENTS_WS_NAMESPACE,
  IM_WS_EVENTS,
  type ConversationSummary,
  type GlobalEventEnvelope,
  type ImConversationReadEvent,
  type ImMessage,
  type ImReadInput,
  type ImSendInput,
  type PresenceState,
} from "@meshbot/types";
import {
  AGENT_EVENTS,
  type AgentChangedEvent,
  QUICK_ASSISTANT_EVENTS,
  type QuickAssistantRenamedEvent,
  MODEL_CONFIG_EVENTS,
  type ModelConfigUpdatedEvent,
  REMOTE_AGENT_EVENTS,
  type RemoteAgentRegistryChangedEvent,
  type RemoteAgentSessionEventPayload,
  SCHEDULE_EVENTS,
  type ScheduleFiredEvent,
  SESSION_LIFECYCLE_EVENTS,
  type SessionCreatedEvent,
  type SessionDeletedEvent,
  type SessionRenamedEvent,
  SESSION_STATUS_EVENTS,
  type SessionStatusChangedEvent,
} from "@meshbot/types-agent";
import { UseFilters, UseGuards } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from "@nestjs/websockets";
import type { Socket } from "socket.io";
import { AccountContextService } from "@meshbot/lib-agent";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import {
  IM_RELAY_EVENTS,
  type ImRelayAgentRegistryChangedEvent,
} from "../cloud/im-relay.events";
import { AUTH_EVENTS } from "../services/auth.events";

/**
 * 本地事件总线 WebSocket Gateway。端点：ws://<host>/ws/events
 *
 * - 复用 BaseWebSocketGateway 的握手鉴权 + 未鉴权宽限回收
 * - 下行（云端 → 本地浏览器）：统一信封 `{type, payload, ts}` 以单一 `event` 名
 *   按账号路由到 `acct:<cloudUserId>` 房间——多账号同时在线时每个事件只投递给
 *   所属账号的浏览器，避免重复投递与跨账号泄漏
 * - 上行（本地浏览器 → 云端）：im.send / im.read 由浏览器触发，
 *   转交 ImRelayClientService 经云端 socket 上行；未连接时 send 抛
 *   IM_NOT_CONNECTED，由 WsExceptionFilter 统一处理
 */
@WebSocketGateway({ namespace: EVENTS_WS_NAMESPACE, cors: true })
@UseFilters(WsExceptionFilter)
export class EventsGateway extends BaseWebSocketGateway {
  /** 每账号当前浏览器（ws/events）连接数；0↔1 跳变时驱动 relay 上报在线/离线。 */
  private readonly browserCounts = new Map<string, number>();

  constructor(
    private readonly jwt: JwtService,
    private readonly imRelay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {
    super();
  }

  protected jwtVerify(token: string): unknown {
    return this.jwt.verify(token);
  }

  /**
   * 浏览器连接：保留基类未鉴权回收，并把已鉴权 socket 按账号加入 `acct:<sub>` 房间。
   * 下行事件据此只投递给所属账号的浏览器——多账号同时在线时（如本地登录多账号、
   * 或开发期多窗口）避免同一事件经各账号 relay 重复广播、以及跨账号泄漏。
   */
  handleConnection(client: Socket): void {
    super.handleConnection(client);
    const sub = (client.data?.user as { sub?: unknown } | undefined)?.sub;
    if (typeof sub === "string") {
      client.join(`acct:${sub}`);
      // 回放当前已知在线快照给这个新浏览器——修「浏览器晚于 relay 连接、错过 server-main
      // 初始在线快照」导致早已在线的对端一直显示离线（presenceAtom 初值为空=灰）。
      for (const userId of this.imRelay.getOnlinePeers(sub)) {
        const env: GlobalEventEnvelope = {
          type: IM_WS_EVENTS.presence,
          payload: { userId, online: true } satisfies PresenceState,
          ts: Date.now(),
        };
        client.emit("event", env);
      }
      // 在线状态：浏览器连接数 0→1 → 该账号上线
      const n = (this.browserCounts.get(sub) ?? 0) + 1;
      this.browserCounts.set(sub, n);
      if (n === 1) {
        this.imRelay.setUiPresence(sub, true);
      }
    }
  }

  /**
   * 浏览器断开：连接数 1→0 → 该账号离线（关最后一个窗口即离线）。
   * 多窗口时仅减计数、保持在线。
   */
  handleDisconnect(client: Socket): void {
    const sub = (client.data?.user as { sub?: unknown } | undefined)?.sub;
    if (typeof sub !== "string") return;
    const n = (this.browserCounts.get(sub) ?? 0) - 1;
    if (n <= 0) {
      this.browserCounts.delete(sub);
      this.imRelay.setUiPresence(sub, false);
    } else {
      this.browserCounts.set(sub, n);
    }
  }

  /**
   * 云端下行：新 IM 消息 → 信封投递给所属账号浏览器。
   *
   * ImRelayClientService 收到云端 `im.message` 后经 EventEmitter2 触发此方法。
   */
  @OnEvent(IM_WS_EVENTS.message)
  onMessage(payload: ImMessage): void {
    this.emitEnvelope(IM_WS_EVENTS.message, payload);
  }

  /**
   * 云端下行：用户在线状态变更 → 信封投递。
   *
   * ImRelayClientService 收到云端 `im.presence` 后经 EventEmitter2 触发此方法。
   */
  @OnEvent(IM_WS_EVENTS.presence)
  onPresence(payload: PresenceState): void {
    this.emitEnvelope(IM_WS_EVENTS.presence, payload);
  }

  /**
   * 云端下行：新会话创建通知 → 信封投递。
   *
   * ImRelayClientService 收到云端 `im.conversation_created` 后经 EventEmitter2
   * 触发此方法，浏览器刷新会话列表。
   */
  @OnEvent(IM_WS_EVENTS.conversationCreated)
  onConversationCreated(payload: ConversationSummary): void {
    this.emitEnvelope(IM_WS_EVENTS.conversationCreated, payload);
  }

  /**
   * 云端下行：频道被移除通知 → 信封投递。
   *
   * ImRelayClientService 收到云端 `im.conversation_removed` 后经 EventEmitter2
   * 触发此方法，浏览器刷新会话列表。
   */
  @OnEvent(IM_WS_EVENTS.conversationRemoved)
  onConversationRemoved(payload: { conversationId: string }): void {
    this.emitEnvelope(IM_WS_EVENTS.conversationRemoved, payload);
  }

  /**
   * 云端下行：会话已读通知 → 信封投递。
   *
   * ImRelayClientService 收到云端 `im.conversation_read` 后经 EventEmitter2
   * 触发此方法，浏览器更新会话已读状态。
   */
  @OnEvent(IM_WS_EVENTS.conversationRead)
  onConversationRead(payload: ImConversationReadEvent): void {
    this.emitEnvelope(IM_WS_EVENTS.conversationRead, payload);
  }

  /**
   * 本地定时任务触发 → 信封投递给所属账号浏览器。
   *
   * ScheduleExecutor.fire 触发后经 EventEmitter2 触发此方法，
   * 浏览器可据此刷新任务状态或显示触发通知。
   */
  @OnEvent(SCHEDULE_EVENTS.fired)
  onScheduleFired(payload: ScheduleFiredEvent): void {
    this.emitEnvelope(SCHEDULE_EVENTS.fired, payload);
  }

  /**
   * 会话运行状态变更（idle ↔ running）→ 信封投递给所属账号浏览器，
   * 侧栏「运行中」绿点在任何路由都实时落态。
   *
   * RunnerService.setSessionStatus 在 `account.run(owner, ...)` 上下文内 emit，
   * 故 emitEnvelope 能取到账号并路由到 acct 房间。走全局总线而非 ws/session：
   * 后者只在会话页挂载时建连，/home 与消息页的侧栏收不到。
   */
  @OnEvent(SESSION_STATUS_EVENTS.changed)
  onSessionStatusChanged(payload: SessionStatusChangedEvent): void {
    this.emitEnvelope(SESSION_STATUS_EVENTS.changed, payload);
  }

  /**
   * 本地新建会话 → 信封投递给所属账号浏览器，侧栏会话列表实时插入新行。
   *
   * `SessionService.createSession` 在 `createSessionInTx` 事务提交之后 emit
   * （REST 建会话 `SessionController.create` / 远程 run 入站建会话
   * `RemoteRunInboundService.onAgentRunRequest` 两条路径共用同一方法，因而
   * 共用同一发射点：前者经 REST 鉴权拦截器建账号上下文，后者显式
   * `account.run(cloudUserId, ...)`），故 emitEnvelope 能取到账号并路由到
   * acct 房间。子 Agent 会话（`createSubSession`）与随手问会话
   * （`kind="quick"`）刻意不触发这个事件——两者都不进侧栏，发了只会让侧栏
   * 凭空多出一行（quick 的排除见 `SessionService.createSession` 内注释）。
   */
  @OnEvent(SESSION_LIFECYCLE_EVENTS.created)
  onSessionCreated(payload: SessionCreatedEvent): void {
    this.emitEnvelope(SESSION_LIFECYCLE_EVENTS.created, payload);
  }

  /**
   * 本地会话删除 → 信封投递给所属账号浏览器，侧栏会话列表实时移除对应行。
   *
   * 两条发射路径都在账号上下文内 emit：单会话直接删（`SessionService
   * .deleteSession`，REST 经鉴权拦截器）；Agent 整体删除的级联删除路径
   * （`AgentService.removeWithData`，同样 REST 触发）——`session.deleted`
   * 特意挪到 `removeWithData` 的 `@Transactional()` 事务**外面**发射（见 commit
   * f8ef6f18），避免事务回滚后「已通知却没真删掉」。两条路径 emitEnvelope
   * 都能取到账号并路由到 acct 房间。
   */
  @OnEvent(SESSION_LIFECYCLE_EVENTS.deleted)
  onSessionDeleted(payload: SessionDeletedEvent): void {
    this.emitEnvelope(SESSION_LIFECYCLE_EVENTS.deleted, payload);
  }

  /**
   * 本地会话改名 → 信封投递给所属账号浏览器，侧栏会话标题实时刷新。
   *
   * 两条发射路径都在账号上下文内 emit：手动改名（`SessionService.patch`，
   * REST 经鉴权拦截器）；LLM 自动生成标题（`patchIfNotGenerated`，由
   * `SessionTitleService` fire-and-forget 触发——脱离了请求的 ALS 账号上下文，
   * 该 Service 显式按会话 owner 重建 `account.run(owner, ...)` 后才调用）。
   * 两条路径 emitEnvelope 都能取到账号并路由到 acct 房间。
   */
  @OnEvent(SESSION_LIFECYCLE_EVENTS.renamed)
  onSessionRenamed(payload: SessionRenamedEvent): void {
    this.emitEnvelope(SESSION_LIFECYCLE_EVENTS.renamed, payload);
  }

  /**
   * 本地 Agent 增删改（含改名）→ 信封投递给所属账号浏览器，侧栏 Agent 列表与
   * 会话标题栏实时刷新（前端 invalidate `["agents"]` 查询）。
   *
   * 发射点在 `AgentService.create/update/removeWithData`，故表单改名（REST
   * `AgentController.update`）与 `rename_agent` 工具改名（`AGENT_RENAME_PORT`）
   * 两条路径都会走到这里——修「工具改名后侧栏/标题栏仍显示旧名」。
   * 两条路径都在账号上下文内 emit（REST 经鉴权拦截器、工具经 GraphService.run），
   * 故 emitEnvelope 能取到账号并路由到 acct 房间。
   */
  @OnEvent(AGENT_EVENTS.changed)
  onAgentChanged(payload: AgentChangedEvent): void {
    this.emitEnvelope(AGENT_EVENTS.changed, payload);
  }

  /**
   * 本地随手问改名 → 信封投递给所属账号浏览器，dock 标题实时刷新。
   *
   * QuickAssistantController.rename（UI 改名，写默认 Agent 的 name）与
   * `rename_agent` 工具（`AGENT_RENAME_PORT`，见 runtime-context.module）都会
   * 在改到默认 Agent 时 emit 此事件；两者都在账号上下文内 emit，故 emitEnvelope
   * 能取到账号路由到 acct 房间。与上面的 `agent.changed` 分工：这个只喂 dock 的
   * `quickAssistantNameAtom`（默认 Agent 的显示名），那个失效整份 Agent 列表缓存。
   */
  @OnEvent(QUICK_ASSISTANT_EVENTS.renamed)
  onQuickAssistantRenamed(payload: QuickAssistantRenamedEvent): void {
    this.emitEnvelope(QUICK_ASSISTANT_EVENTS.renamed, payload);
  }

  /**
   * 云端模型配置变更（代理缓存已失效）→ 信封投递给所属账号浏览器，模型列表实时刷新。
   *
   * CloudModelConfigProxyService 收到云端广播 modelConfigChanged 后清缓存并
   * 经 EventEmitter2 触发，前端收到后 invalidate model-configs 查询。
   */
  @OnEvent(MODEL_CONFIG_EVENTS.updated)
  onModelConfigUpdated(payload: ModelConfigUpdatedEvent): void {
    this.emitEnvelope(MODEL_CONFIG_EVENTS.updated, payload);
  }

  /**
   * 云端下行：远程 Agent 注册表变更 → 信封投递给所属账号浏览器，侧栏/起手台的
   * 远程 Agent 列表实时增删（修「B 关掉允许远程后 A 客户端列表不消失」）。
   *
   * `ImRelayClientService` 收到云端广播 `im.agent_registry_changed` 后在
   * `account.run(cloudUserId, ...)` 上下文内 emit，故 emitEnvelope 能取到账号
   * 并路由到 acct 房间。前端收到后 invalidate `remote-agents` 查询。
   *
   * 两个已知盲区（云端广播侧限制，退化为「不实时」而非「永久错」，由 web-agent
   * socket 重连时的补拉兜底）：
   * 1. 设备/用户未归属组织（server-main 侧 orgId 为 null）→ 无房间可投，云端跳过。
   * 2. A、B 两台设备的 `device.orgId` 不同（设备 orgId 与用户 activeOrgId 解耦）
   *    → 广播用变更方的 orgId 房间，投不到 A。
   */
  @OnEvent(IM_RELAY_EVENTS.agentRegistryChanged)
  onRemoteAgentsChanged(payload: ImRelayAgentRegistryChangedEvent): void {
    this.emitEnvelope(REMOTE_AGENT_EVENTS.registryChanged, {
      cloudUserId: payload.cloudUserId,
    } satisfies RemoteAgentRegistryChangedEvent);
  }

  /**
   * 远程 Agent 的会话生命周期镜像 → 信封投递给所属账号浏览器（Agent 级观察
   * 通道，修缺口 ②）。
   *
   * **专属信封而非复用本地 `session.created` 等事件名**：本地那条总线上挂着
   * `AgentWatchMirrorService`（会把收到的事件当本机事件再镜像出去 → 回环）与
   * 本网关的本地下发路径（浏览器会把远程会话插进**本机**列表）。故包进
   * `remote-agent.session_event` 信封并携带**云端 agentId**，浏览器按 agentId
   * 分流到对应远程 Agent 的视图——与 `REMOTE_SHADOW_FRAME_EVENT` 不复用原始
   * `SESSION_WS_EVENTS.*` 名是同一个理由。
   */
  @OnEvent(REMOTE_AGENT_EVENTS.sessionEvent)
  onRemoteAgentSessionEvent(payload: RemoteAgentSessionEventPayload): void {
    this.emitEnvelope(REMOTE_AGENT_EVENTS.sessionEvent, payload);
  }

  /**
   * 本地：云端凭据吊销/401（relay connect_error unauthorized 或 CloudClient 401
   * unauthorizedHandler）→ 信封投递给所属账号浏览器，提示重新授权登录。
   *
   * 发射方（ImRelayClientService / auth.module CloudClientService 工厂）已用
   * `account.run(cloudUserId, ...)` 包裹 emit，故此处 emitEnvelope 能取到账号路由。
   */
  @OnEvent(AUTH_EVENTS.reauthRequired)
  onReauthRequired(payload: { cloudUserId: string }): void {
    this.emitEnvelope(AUTH_WS_EVENTS.reauthRequired, payload);
  }

  /**
   * 下行投递：把任意事件包成全局信封 `{type,payload,ts}`，以单一 `event` 名只发给
   * 当前下行事件所属账号的 acct 房间（relay 经 account.run 同步触发，故能取到账号）。
   * 无账号上下文（理论不应发生）→ 降级全量广播，保证不丢。
   */
  private emitEnvelope(type: string, payload: unknown): void {
    const env: GlobalEventEnvelope = { type, payload, ts: Date.now() };
    const cloudUserId = this.account.get();
    if (!cloudUserId) {
      this.server.emit("event", env);
      return;
    }
    this.server.to(`acct:${cloudUserId}`).emit("event", env);
  }

  /**
   * 上行：浏览器发送 IM 消息 → 转交 ImRelayClientService 经云端 socket 上行。
   *
   * 账号来源：握手期 JWT middleware 写入的 `client.data.user`（payload
   * `{ sub: cloudUserId, email }`），`WsAuthGuard` 已保证其存在，`sub` 即云端账号 id，
   * 用以定位该账号的云连接（v3 每账号独立连接）。
   * 未连接时 ImRelayClientService.send 抛 AppError(IM_NOT_CONNECTED)，
   * WsExceptionFilter 统一转为 WsException 回传客户端。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.send)
  handleSend(
    @MessageBody() body: ImSendInput,
    @ConnectedSocket() client: Socket,
  ): void {
    this.imRelay.send(this.cloudUserId(client), body);
  }

  /**
   * 上行：浏览器标记消息已读 → 转交 ImRelayClientService 经云端 socket 上行。
   *
   * 账号来源同 handleSend（`client.data.user.sub`）。
   * best-effort：ImRelayClientService.read 未连接时静默跳过，无需处理异常。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.read)
  handleRead(
    @MessageBody() body: ImReadInput,
    @ConnectedSocket() client: Socket,
  ): void {
    this.imRelay.read(this.cloudUserId(client), body);
  }

  /**
   * 从已鉴权 socket 解析云端账号 id（本地 JWT 的 `sub`）。
   * `WsAuthGuard` 保证 `client.data.user` 存在；缺 `sub` 视为未鉴权。
   */
  private cloudUserId(client: Socket): string {
    const user = client.data?.user as { sub?: unknown } | undefined;
    if (typeof user?.sub !== "string") {
      throw new WsException(new AppError(CommonErrorCode.UNAUTHORIZED));
    }
    return user.sub;
  }
}
