import {
  AppError,
  BaseWebSocketGateway,
  WsAuthGuard,
  WsExceptionFilter,
} from "@meshbot/common";
import {
  CLOUD_AGENT_EVENTS,
  CloudAgentService,
  type CloudAgentChangedEvent,
  ConversationService,
  DEVICE_TOKEN_PREFIX,
  DevicePresenceService,
  DeviceService,
  MainErrorCode,
  MessageService,
  PresenceService,
  UserService,
  ORG_MODEL_CONFIG_EVENTS,
  type OrgModelConfigChangedEvent,
} from "@meshbot/main";
import {
  type AgentRunControlForwarded,
  type AgentRunControlInput,
  type AgentRunEnd,
  type AgentRunFrame,
  type AgentRunStartForwarded,
  type AgentRunStartInput,
  type AgentWatchAccepted,
  type AgentWatchForwarded,
  type AgentWatchFrame,
  type AgentWatchStartInput,
  type AgentWatchStopInput,
  IM_WS_EVENTS,
  IM_WS_NAMESPACE,
  type ConversationSummary,
  type DeviceQueryForwarded,
  type DeviceQueryRequestInput,
  type DeviceQueryResponse,
  type ImConversationReadEvent,
  type ImPresenceSetInput,
  type ImReadInput,
  type ImSendInput,
  type PresenceState,
  type WatchScope,
} from "@meshbot/types";
import {
  Logger,
  type OnModuleDestroy,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";

/** watch 路由的 idle 回收阈值（与设备侧 `WATCH_IDLE_MS` 同值，两侧独立各扫各的）。 */
export const WATCH_IDLE_MS = 5 * 60 * 1000;
/** idle 清扫周期。 */
const WATCH_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * L3 发起方泛化：agent.run.* / device.query.* 的发起方既可能是设备连接
 * （web-agent/CLI，room 稳定，deviceId 断线不变），也可能是浏览器用户连接
 * （web-main，无 deviceId，room 语义不适用，断线即毁只能靠 socket.id 直发）。
 */
type RunRequester =
  | { kind: "device"; deviceId: string }
  | { kind: "user"; socketId: string };

/** Agent 级观察通道的一条观察路由（spec §B）。 */
interface WatchRoute {
  requester: RunRequester;
  scope: WatchScope;
  /** 寻址目标：云端 Agent id。 */
  targetAgentId: string;
  /** 由 targetAgentId 解出的目标设备本地 Agent id（转发给设备用）。 */
  localAgentId: string;
  /** 宿主设备 id。字段名受泛型 `cleanupRoutes` 的读取面约束，不可改名。 */
  targetDeviceId: string;
  /** scope="session" 时为被观察会话 id。 */
  sessionId?: string;
  /** 发起 watch 的用户 id（HITL watchId 寻址的越权校验用，见 Task 16）。 */
  userId: string;
  /**
   * 最近一次帧活动时间戳（`registerWatch` 时 `Date.now()`，`handleAgentWatchFrame`
   * fan-out 命中该 route 时续期）。`sweepIdleWatches` 按此字段回收 idle watch
   * （泄漏防线 4 的云端半边）。
   */
  lastActiveAt: number;
}

/**
 * IM WebSocket Gateway —— Phase 2 B6。
 *
 * 端点：`ws://<host>/ws/im`
 *
 * 职责：
 * - 连接时鉴权 → 入 org + conv 房间 + presence 上线 + 快照下发
 * - 断连时 presence 下线 + 广播
 * - im.send：可见性校验 → 持久化 → 房间广播
 * - im.read：标记已读
 * - im.ping：续期 presence TTL（server-agent 每 ~20s 发一次）
 * - im.conversation_created 事件（EventEmitter2）：转发到相关用户 socket
 *
 * 鉴权：handshake auth.token / query.token，由 BaseWebSocketGateway 中间件验证。
 * 未鉴权连接在宽限期（10s）内无消息即主动断开。
 *
 * ---
 * **B7 Controller 约定**：建频道/DM 成功后必须通过 EventEmitter2 发出事件：
 * ```ts
 * eventEmitter.emit(IM_WS_EVENTS.conversationCreated, {
 *   summary: ConversationSummary,
 *   userIds: string[],  // 应收到通知的用户 id 列表
 *   orgId: string,      // 用于缩小 fetchSockets 范围
 * });
 * ```
 */
@WebSocketGateway({ namespace: IM_WS_NAMESPACE, cors: true })
@UseFilters(WsExceptionFilter)
export class ImGateway extends BaseWebSocketGateway implements OnModuleDestroy {
  private readonly logger = new Logger(ImGateway.name);

  /** watch idle 清扫定时器句柄（`afterInit` 起、`onModuleDestroy` 清）。 */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * L3 Phase A:agent.run.* 流的 streamId 路由表。
   * agentRunStart 校验通过后登记 `{requester, targetAgentId, targetDeviceId, localAgentId}`
   * ——targetAgentId 是寻址目标(云端 Agent id)，targetDeviceId 是按 targetAgentId
   * 查 CloudAgentService 解出的宿主设备 id(计划二 2b:寻址从设备细化到设备上的
   * 某 Agent，但回流帧来自**设备**连接，只有 deviceId 可比对身份，故两者都存)；
   * agentRunControl 据此校验发起方身份(越权拒)并定向下发(附 localAgentId 供
   * B 侧确认帧路由)；agentRunEnd 清理。
   * 进程内 Map，server-main 多实例部署时需迁移到共享存储(当前 Phase A 范围外)。
   */
  private readonly agentRunRoutes = new Map<
    string,
    {
      requester: RunRequester;
      targetAgentId: string;
      targetDeviceId: string;
      localAgentId: string;
    }
  >();

  /**
   * L2c device.query.* 的 correlationId 一次性路由表（安全修复）：
   * `handleDeviceQueryRequest` 转发成功（同账号 + 在线）才登记
   * `{requester, targetAgentId, targetDeviceId}`（targetDeviceId 是按
   * targetAgentId 查 CloudAgentService 解出的宿主设备 id）；
   * `handleDeviceQueryResponse` 据此校验回流发送方 = 登记的 targetDeviceId
   * （回流帧来自**设备**连接，只有 deviceId 可比对身份，agentId 不是连接
   * 层身份；否则任意已认证设备可伪造响应，借 `"user:<socketId>"` 编码直发
   * 任意浏览器连接），通过后用**登记的** requester 路由（不再信任
   * body.requesterDeviceId）并删表项（一次性，同 correlationId 第二次响应
   * 被丢弃）。与 agentRunRoutes 同源：进程内 Map，server-main 多实例部署时
   * 需迁移到共享存储。
   */
  private readonly queryRoutes = new Map<
    string,
    { requester: RunRequester; targetAgentId: string; targetDeviceId: string }
  >();

  /**
   * Agent 级观察通道（spec §B）：watchId → 观察路由。
   *
   * 与 `agentRunRoutes`（streamId → **单个** requester 的 1:1）的关键差异：
   * watch 是 **1:N fan-out**——同一个会话/Agent 可能有多个观察者，故除主表外
   * 另有两张**反向索引表**（`agentWatchers` / `sessionWatchers`）。设备侧对
   * 每个 agent/session **只上行一份**镜像帧，由本网关按索引表扇出成一份份带
   * watchId 的 `AgentRunFrame`（spec §C 取舍：省设备上行，观察者增减不影响
   * 设备侧行为）。
   *
   * Agent 级与 Session 级**共用同一个 watchId 命名空间、同一张主表**，靠
   * `scope` 字段区分——清理路径（四条）因此只需维护这一张主表 + 两张索引，
   * 不必为两级各造一套。
   *
   * `targetDeviceId` 字段名**不可改**：泛型 `cleanupRoutes` 按
   * `{requester, targetDeviceId}` 读取面约束，改名会让本表用不上那套复用。
   *
   * 进程内 Map，server-main 多实例部署时需迁移到共享存储（同 agentRunRoutes /
   * queryRoutes 的既有限制）。
   */
  private readonly watchRoutes = new Map<string, WatchRoute>();

  /**
   * Agent 级 fan-out 反向索引：`${deviceId}:${localAgentId}` → watchId 集合。
   *
   * 键用**设备本地** agentId 而非云端 targetAgentId：设备回发的
   * `AgentWatchFrame.localAgentId` 是它自己的本地 id（设备根本不知道云端
   * agent id），fan-out 时按「发送方 deviceId + 帧里的 localAgentId」查表，
   * 键必须同构才查得到。
   */
  private readonly agentWatchers = new Map<string, Set<string>>();

  /** Session 级 fan-out 反向索引：`${deviceId}:${sessionId}` → watchId 集合。 */
  private readonly sessionWatchers = new Map<string, Set<string>>();

  constructor(
    private readonly jwt: JwtService,
    private readonly conversation: ConversationService,
    private readonly message: MessageService,
    private readonly presence: PresenceService,
    private readonly userService: UserService,
    private readonly devices: DeviceService,
    private readonly devicePresence: DevicePresenceService,
    private readonly agents: CloudAgentService,
  ) {
    super();
  }

  /**
   * 网关初始化：先走基类 `afterInit`（trace + jwt middleware 挂载，**必须**
   * 保留，否则鉴权中间件不生效），再起 watch idle 清扫定时器（`unref` 防
   * 阻塞进程退出，纯兜底职责不该延长进程生命周期）。
   */
  afterInit(server: Server): void {
    super.afterInit(server);
    const timer = setInterval(
      () => this.sweepIdleWatches(),
      WATCH_SWEEP_INTERVAL_MS,
    );
    timer.unref?.();
    this.sweepTimer = timer;
  }

  /** 模块销毁时清掉 idle 清扫定时器，防进程内测试/热重载残留计时器。 */
  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * 双凭据握手校验（Task 8）：
   * - `mbd_` 前缀（Agent device token）→ `DeviceService.verifyToken`（异步），
   *   payload 为 `{ userId, orgId, deviceId }`（orgId 来自 device.orgId，无 email）
   * - 其余走浏览器用户 JWT 同步 verify，行为不变
   */
  protected jwtVerify(token: string): unknown {
    if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
      return this.devices
        .verifyToken(token)
        .then((d) => ({ userId: d.userId, orgId: d.orgId, deviceId: d.id }));
    }
    return this.jwt.verify(token);
  }

  /** 从连接推导发起方身份：设备连接用 deviceId（room 稳定），用户连接用 socket.id（断线即毁）。 */
  private requesterOf(client: Socket): RunRequester {
    const deviceId = (client.data.user as { deviceId?: string })?.deviceId;
    return deviceId
      ? { kind: "device", deviceId }
      : { kind: "user", socketId: client.id };
  }

  /** 转发帧 requesterDeviceId 字段编码（B 端原样回填不解析）。 */
  private encodeRequester(r: RunRequester): string {
    return r.kind === "device" ? r.deviceId : `user:${r.socketId}`;
  }

  /**
   * 回流定向：device 走 `device:<id>` room；user 走 `<socketId>` room
   * （socket.io 每个连接自动加入以自身 id 命名的 room，`this.server` 在本
   * namespace gateway 里运行时是 Namespace 实例，用 `.to(id).emit(...)` 与
   * device 分支同构，不能假设存在 `sockets.sockets` 二层 Map）。
   * 目标 socket 已断连时 room 内无成员，emit 静默无操作（无异常）。
   */
  private emitToRequester(
    r: RunRequester,
    event: string,
    payload: unknown,
  ): void {
    if (r.kind === "device") {
      this.server.to(`device:${r.deviceId}`).emit(event, payload);
      return;
    }
    this.server.to(r.socketId).emit(event, payload);
  }

  /** 校验两个发起方是否同一身份（kind + id 全等）；跨 kind 或 id 不同均视为不同发起方。 */
  private sameRequester(a: RunRequester, b: RunRequester): boolean {
    if (a.kind === "device" && b.kind === "device") {
      return a.deviceId === b.deviceId;
    }
    if (a.kind === "user" && b.kind === "user") {
      return a.socketId === b.socketId;
    }
    return false;
  }

  /**
   * 断连清理共用逻辑（`agentRunRoutes` / `queryRoutes` / `watchRoutes` 三表同构，
   * value 形状不同故用泛型约束到共有的 `{requester, targetDeviceId}` 读取面）：
   * - device 分支：按 deviceId 键，双向清理（该连接作为发起方或目标涉及的路由项都删）。
   * - user 分支：浏览器用户连接无 deviceId，断线即毁，仅按 client.id(socket.id) 清理其
   *   作为发起方的路由（user 连接不会是 targetDeviceId，无需对称清理 target 侧）。
   *
   * `onRemoved`（Agent 级观察通道新增）：主表删除某项时回调，供 `watchRoutes`
   * 同步清理两张反向索引表 + 通知设备 stop。**两个既有调用点不传此参，行为
   * 完全不变**——扩展而非改写，正是为了让 watch 复用这套判定，不新造第二份
   * 断线清理逻辑。
   */
  private cleanupRoutes<
    T extends { requester: RunRequester; targetDeviceId: string },
  >(
    routes: Map<string, T>,
    client: Socket,
    deviceId: string | undefined,
    onRemoved?: (key: string, route: T) => void,
  ): void {
    if (deviceId) {
      for (const [key, route] of routes) {
        if (
          (route.requester.kind === "device" &&
            route.requester.deviceId === deviceId) ||
          route.targetDeviceId === deviceId
        ) {
          routes.delete(key);
          onRemoved?.(key, route);
        }
      }
    } else {
      for (const [key, route] of routes) {
        if (
          route.requester.kind === "user" &&
          route.requester.socketId === client.id
        ) {
          routes.delete(key);
          onRemoved?.(key, route);
        }
      }
    }
  }

  /** 索引键：Agent 级。 */
  private static agentWatchKey(deviceId: string, localAgentId: string): string {
    return `${deviceId}:${localAgentId}`;
  }

  /** 索引键：Session 级。 */
  private static sessionWatchKey(deviceId: string, sessionId: string): string {
    return `${deviceId}:${sessionId}`;
  }

  /**
   * 三表一致地登记一条 watch 路由（主表 + 对应 scope 的反向索引）。
   * `lastActiveAt` 由本方法统一盖 `Date.now()`——调用方（`handleAgentWatchStart`）
   * 不必知道 idle 清扫的存在，故入参类型剔除该字段。
   */
  private registerWatch(
    watchId: string,
    route: Omit<WatchRoute, "lastActiveAt">,
  ): void {
    // 幂等：同一 watchId 重复登记时先按**旧**路由把索引清干净，再写新的。
    // 否则 `watchRoutes` 被原地覆盖、而旧索引 Set 里那条 watchId 留了下来，
    // 变成指向已失效路由的悬挂项——fan-out 是按索引 Set 反查主表的，悬挂项
    // 会把帧扇到新 route 的 requester 身上（跨会话/跨 Agent 串台）。
    if (this.watchRoutes.has(watchId)) {
      this.unregisterWatch(watchId, false);
    }
    const fullRoute: WatchRoute = { ...route, lastActiveAt: Date.now() };
    this.watchRoutes.set(watchId, fullRoute);
    const index =
      fullRoute.scope === "agent" ? this.agentWatchers : this.sessionWatchers;
    const key =
      fullRoute.scope === "agent"
        ? ImGateway.agentWatchKey(
            fullRoute.targetDeviceId,
            fullRoute.localAgentId,
          )
        : ImGateway.sessionWatchKey(
            fullRoute.targetDeviceId,
            fullRoute.sessionId ?? "",
          );
    let set = index.get(key);
    if (!set) {
      set = new Set<string>();
      index.set(key, set);
    }
    set.add(watchId);
  }

  /** 只清两张反向索引（主表已由调用方删除时用，如 cleanupRoutes 的 onRemoved）。 */
  private removeWatchIndex(watchId: string, route: WatchRoute): void {
    const index =
      route.scope === "agent" ? this.agentWatchers : this.sessionWatchers;
    const key =
      route.scope === "agent"
        ? ImGateway.agentWatchKey(route.targetDeviceId, route.localAgentId)
        : ImGateway.sessionWatchKey(
            route.targetDeviceId,
            route.sessionId ?? "",
          );
    const set = index.get(key);
    if (!set) return;
    set.delete(watchId);
    if (set.size === 0) index.delete(key); // 空集合即删键，防 Map 无界增长
  }

  /** 通知目标设备注销某 watch（观察者已走/idle 超时，设备侧该释放常驻转发器了）。 */
  private notifyWatchStop(watchId: string, route: WatchRoute): void {
    this.server
      .to(`device:${route.targetDeviceId}`)
      .emit(IM_WS_EVENTS.agentWatchForwarded, {
        watchId,
        localAgentId: route.localAgentId,
        scope: route.scope,
        sessionId: route.sessionId,
        action: "stop",
        requesterDeviceId: this.encodeRequester(route.requester),
      } satisfies AgentWatchForwarded);
  }

  /**
   * 通知**观察者**它的 watch 已失效（宿主设备断线时用）。
   *
   * 方向与 `notifyWatchStop` 相反：那条是告诉设备「别转发了」，这条是告诉
   * 观察者「你看的那台设备没了」。观察者自己的连接完好，不会自然感知到宿主
   * 掉线——不发这条它只会静默地不再收帧，界面停在半截且毫无提示。
   * 复用 `agentWatchAccepted{ok:false, reason:"offline"}`：观察者端本就要处理
   * `ok:false` 分支，无需新增协议。
   */
  private notifyWatcherOffline(watchId: string, route: WatchRoute): void {
    this.emitToRequester(route.requester, IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: false,
      reason: "offline",
    } satisfies AgentWatchAccepted);
  }

  /**
   * 三表一致地注销一条 watch 路由，并（可选）通知设备 stop。
   * 门面方法：删主表 + 调 `removeWatchIndex` + （可选）`notifyWatchStop`。
   * **全部注销路径最终都落到 `removeWatchIndex`（唯一清索引出口）**，杜绝
   * 「主表删了索引没删」的半清理泄漏：显式 unwatch（本方法）/ 观察者断线 /
   * 设备断线（`cleanupRoutes` 的 `onRemoved` 直接调 `removeWatchIndex`，不
   * 经本方法——因为主表已被 `cleanupRoutes` 删过，重入本方法会因
   * `watchRoutes.get` 落空而空跑，见 `handleDisconnect`）/ idle（本方法）
   * 外加设备回 `watch_accepted{ok:false}` 时的即时注销（T9，本方法）。
   * @param notifyDevice 设备自身断线时为 false（设备已不在，通知无意义且会
   *                     往一个空房间发帧）。
   */
  private unregisterWatch(watchId: string, notifyDevice: boolean): void {
    const route = this.watchRoutes.get(watchId);
    if (!route) return;
    this.watchRoutes.delete(watchId);
    this.removeWatchIndex(watchId, route);
    if (notifyDevice) this.notifyWatchStop(watchId, route);
  }

  /**
   * idle 清扫（泄漏防线 4 的云端半边）：回收超过 {@link WATCH_IDLE_MS} 没有
   * 任何帧活动的 watch 路由。
   *
   * 为什么断线清理之外还要这一条：socket.io 的断线检测有窗口期，且存在
   * 「连接还活着但客户端早已导航离开、忘了发 unwatch」的场景（页面被后台
   * 挂起、JS 异常打断了 cleanup）。常驻转发器没有天然终点，多一层兜底。
   *
   * 公开方法而非私有：测试直接调它验证回收语义，不必等真实定时器。
   */
  sweepIdleWatches(): void {
    const now = Date.now();
    for (const [watchId, route] of this.watchRoutes) {
      if (now - route.lastActiveAt >= WATCH_IDLE_MS) {
        this.unregisterWatch(watchId, true);
      }
    }
  }

  /** 诊断/测试探针：当前 watch 路由数。 */
  watchRouteCount(): number {
    return this.watchRoutes.size;
  }

  /** 诊断/测试探针：某设备某本地 Agent 的观察者 watchId 列表。 */
  agentWatcherIds(deviceId: string, localAgentId: string): string[] {
    return [
      ...(this.agentWatchers.get(
        ImGateway.agentWatchKey(deviceId, localAgentId),
      ) ?? []),
    ];
  }

  /** 诊断/测试探针：某设备某会话的观察者 watchId 列表。 */
  sessionWatcherIds(deviceId: string, sessionId: string): string[] {
    return [
      ...(this.sessionWatchers.get(
        ImGateway.sessionWatchKey(deviceId, sessionId),
      ) ?? []),
    ];
  }

  /**
   * 解析连接归属 orgId：
   * - device 连接（payload 带 deviceId）→ 直接用握手 payload 的 orgId（device.orgId），
   *   不查 activeOrgId（设备当前组织与用户浏览器活跃组织解耦）
   * - 用户 JWT 连接 → 保持现状查 `userService.findById(...).activeOrgId`
   */
  private async resolveOrgId(client: Socket): Promise<string | undefined> {
    const payload = client.data.user as {
      userId: string;
      orgId?: string | null;
      deviceId?: string;
    };
    if (payload.deviceId) return payload.orgId ?? undefined;
    const user = await this.userService.findById(payload.userId);
    return user?.activeOrgId ?? undefined;
  }

  /**
   * 连接建立：先走基类宽限计时器，再异步入房间 + presence 上线。
   * 若 jwt middleware 已验证（`client.data.user` 存在），立即执行 onAuthedConnect。
   */
  handleConnection(client: Socket): void {
    super.handleConnection(client);
    if (client.data?.user) {
      // 异步，不阻塞握手响应
      void this.onAuthedConnect(client);
    }
  }

  /**
   * 已鉴权连接后置逻辑：
   * 1. 解析 orgId（device 连接用 payload.orgId，用户 JWT 查 activeOrgId）→ 无 org 直接返回
   * 2. 入 org 房间 + 全部可见 conv 房间
   * 3. 向本连接下发当前在线快照
   *
   * 注意：relay 连接不再自动上线（presence 由 im.presence_set 事件驱动，
   * 由 server-agent EventsGateway 按浏览器连接数聚合后上报）。
   */
  private async onAuthedConnect(client: Socket): Promise<void> {
    try {
      const userId: string = client.data.user.userId;
      const orgId = await this.resolveOrgId(client);
      if (!orgId) return;

      client.data.orgId = orgId;

      client.join(`org:${orgId}`);

      // device 连接（Agent 反向通道）：join device room + 上线 + 广播设备 presence。
      const deviceId = (client.data.user as { deviceId?: string }).deviceId;
      if (deviceId) {
        client.join(`device:${deviceId}`);
        await this.devicePresence.setOnline(orgId, deviceId);
        this.server.to(`org:${orgId}`).emit(IM_WS_EVENTS.presence, {
          userId: `device:${deviceId}`,
          online: true,
        } satisfies PresenceState);
      }

      const convs = await this.conversation.listConversations(userId, orgId);
      for (const conv of convs) {
        client.join(`conv:${conv.id}`);
      }

      // 向本连接下发当前在线用户快照
      const onlineUserIds = await this.presence.listOnline(orgId);
      for (const onlineUserId of onlineUserIds) {
        client.emit(IM_WS_EVENTS.presence, {
          userId: onlineUserId,
          online: true,
        } satisfies PresenceState);
      }

      // 向本连接下发当前在线【设备】快照：设备 presence 仅在连/断的瞬间广播边沿事件，
      // 后连接的设备会错过先在线设备的上线广播且拿不到快照 → 永远看不到对方在线。
      // 补一次快照回放消除这个不对称（device:<deviceId> 形态，与边沿事件一致）。
      const onlineDeviceIds = await this.devicePresence.listOnline(orgId);
      for (const onlineDeviceId of onlineDeviceIds) {
        client.emit(IM_WS_EVENTS.presence, {
          userId: `device:${onlineDeviceId}`,
          online: true,
        } satisfies PresenceState);
      }
    } catch (err) {
      this.logger.error("im onAuthedConnect failed", err as Error);
      client.disconnect(true);
    }
  }

  /**
   * 断连：presence 下线 + 广播给同 org。
   * 仅在已完成鉴权 + 入 org 时执行（否则无 orgId）。
   */
  async handleDisconnect(client: Socket): Promise<void> {
    try {
      const userId: string | undefined = client.data?.user?.userId;
      const orgId: string | undefined = client.data?.orgId;
      const deviceId = (client.data?.user as { deviceId?: string })?.deviceId;

      if (deviceId && orgId) {
        await this.devicePresence.setOffline(orgId, deviceId);
        this.server.to(`org:${orgId}`).emit(IM_WS_EVENTS.presence, {
          userId: `device:${deviceId}`,
          online: false,
        } satisfies PresenceState);
      }

      // L3 发起方泛化:连接断开时清理它参与的 agent.run / device.query 路由
      // (作为发起方或目标)，防路由表泄漏 / 悬挂 streamId・correlationId。
      // - device 分支:按 deviceId 键(room 语义)，orgId 无关，行为不变。
      // - user 分支:浏览器用户连接无 deviceId，断线即毁，按 client.id(socket.id) 键清理其为发起方的路由；
      //   user 连接不会是 targetDeviceId(target 恒为设备)，无需对称清理。
      this.cleanupRoutes(this.agentRunRoutes, client, deviceId);
      this.cleanupRoutes(this.queryRoutes, client, deviceId);
      // Agent 级观察通道（泄漏防线 2/3）：常驻转发器没有「run 终止」这个天然
      // 终点，断线不清就永久泄漏。两条路径语义不同：
      // - 观察者断线（user 分支，deviceId 为 undefined）→ 必须通知设备 stop，
      //   否则设备侧的 SessionWatchService 要等满 5 分钟 idle 才拆。
      // - 设备断线（device 分支）→ 不通知设备（它已不在，往空房间发帧无意义），
      //   但**必须通知观察者**：观察者自己的连接是好的，不会自然感知到宿主
      //   掉线，不发信号它只会静默停更、界面卡在半截（spec §错误处理要求）。
      // 主表由 cleanupRoutes 删除，两张反向索引由 onRemoved 回调同步清理——
      // 走 removeWatchIndex 单一出口，杜绝「主表删了索引没删」的半清理泄漏。
      this.cleanupRoutes(
        this.watchRoutes,
        client,
        deviceId,
        (watchId, route) => {
          this.removeWatchIndex(watchId, route);
          if (deviceId) {
            this.notifyWatcherOffline(watchId, route);
          } else {
            this.notifyWatchStop(watchId, route);
          }
        },
      );

      if (!userId || !orgId) return;

      await this.presence.setOffline(orgId, userId);
      this.server.to(`org:${orgId}`).emit(IM_WS_EVENTS.presence, {
        userId,
        online: false,
      } satisfies PresenceState);
    } catch (err) {
      this.logger.error("im handleDisconnect failed", err as Error);
    }
  }

  /**
   * 发消息：校验可见性 → 持久化 → 推到 conv 房间。
   * WsExceptionFilter 统一处理 AppError（CONVERSATION_NOT_FOUND / FORBIDDEN）。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.send)
  async handleSend(
    @MessageBody() body: ImSendInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const payload = client.data.user as { userId: string };
    const orgId: string | undefined = client.data.orgId;
    if (!orgId) throw new AppError(MainErrorCode.CONVERSATION_FORBIDDEN);

    await this.conversation.getVisibleOrThrow(
      body.conversationId,
      payload.userId,
      orgId,
    );

    const msg = await this.message.persistMessage(
      body.conversationId,
      payload.userId,
      body.content,
    );

    this.server
      .to(`conv:${body.conversationId}`)
      .emit(IM_WS_EVENTS.message, msg);
  }

  /**
   * 标记已读：find + save 更新 lastReadAt，返回写入时间戳。
   * 写完后向「该 userId 的全部在线连接」广播 im.conversation_read（多窗口/多端清未读）。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.read)
  async handleRead(
    @MessageBody() body: ImReadInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const orgId: string | undefined = client.data?.orgId;
    if (!orgId) return;

    const userId: string = client.data.user.userId;

    await this.conversation.getVisibleOrThrow(
      body.conversationId,
      userId,
      orgId,
    );

    const lastReadAt = await this.conversation.markRead(
      body.conversationId,
      userId,
    );

    // 广播给「该用户」的全部在线连接（多窗口/多端清未读）；按 org 房间取连接后按 userId 过滤
    const sockets = await this.server.in(`org:${orgId}`).fetchSockets();
    for (const s of sockets) {
      if (s.data.user?.userId === userId) {
        s.emit(IM_WS_EVENTS.conversationRead, {
          conversationId: body.conversationId,
          lastReadAt: lastReadAt.toISOString(),
        } satisfies ImConversationReadEvent);
      }
    }
  }

  /**
   * L2c / L3 发起方泛化:A 发起设备查询 → 校验同账号 + 在线 → 定向下发到目标设备。
   * A 既可能是设备连接（deviceId），也可能是浏览器用户连接（无 deviceId，用 socketId）。
   */
  @SubscribeMessage(IM_WS_EVENTS.deviceQueryRequest)
  @UseGuards(WsAuthGuard)
  async handleDeviceQueryRequest(
    @MessageBody() body: DeviceQueryRequestInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const requesterUserId = (client.data.user as { userId?: string })?.userId;
    const requester = this.requesterOf(client);
    const reply = (reason: DeviceQueryResponse["reason"]) =>
      this.emitToRequester(requester, IM_WS_EVENTS.deviceQueryResponse, {
        correlationId: body.correlationId,
        requesterDeviceId: this.encodeRequester(requester),
        ok: false,
        reason,
      } satisfies DeviceQueryResponse);
    const agent = await this.agents.findActiveById(body.targetAgentId);
    if (!agent || agent.userId !== requesterUserId) {
      reply("cross_account");
      return;
    }
    const online = await this.devicePresence.isOnline(
      agent.orgId ?? "",
      agent.deviceId,
    );
    if (!online) {
      reply("offline");
      return;
    }
    // 转发成功才登记一次性路由：handleDeviceQueryResponse 据此校验回流发送方
    // 身份（发送方是设备连接，只有 deviceId 可比对，故同时存 targetAgentId
    // 寻址目标与它解出的 targetDeviceId），不再信任 body 里可被任意已认证
    // 设备伪造的 requesterDeviceId。
    this.queryRoutes.set(body.correlationId, {
      requester,
      targetAgentId: agent.id,
      targetDeviceId: agent.deviceId,
    });
    this.server
      .to(`device:${agent.deviceId}`)
      .emit(IM_WS_EVENTS.deviceQueryRequest, {
        ...body,
        requesterDeviceId: this.encodeRequester(requester),
        localAgentId: agent.localAgentId,
      } satisfies DeviceQueryForwarded);
  }

  /**
   * L2c / L3 发起方泛化:目标设备回流 → 按 correlationId 查 `queryRoutes`
   * 登记表，校验发送方确为登记的 targetDeviceId（登记时按 targetAgentId 查
   * CloudAgentService 解出；回流帧来自**设备**连接，只有 deviceId 是连接层
   * 身份，agentId 不是——故校验必须落到 deviceId，不能拿 targetAgentId 比对）。
   * 安全修复：任意已认证设备都能发 deviceQueryResponse，仅挂 WsAuthGuard
   * 不够，必须比对发送方 = handleDeviceQueryRequest 转发时登记的目标设备，
   * 否则可伪造响应借 `"user:<socketId>"` 编码直发任意浏览器连接。
   * 无登记（未知/伪造 correlationId）或发送方非登记目标设备 → 静默丢弃。
   * 校验通过：删除路由项（一次性，同 correlationId 第二次响应被丢弃）后，
   * 用**登记的** requester 路由（不再信任 body.requesterDeviceId）。
   */
  @SubscribeMessage(IM_WS_EVENTS.deviceQueryResponse)
  @UseGuards(WsAuthGuard)
  async handleDeviceQueryResponse(
    @MessageBody() body: DeviceQueryResponse,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const route = this.queryRoutes.get(body.correlationId);
    const senderDeviceId = (client.data.user as { deviceId?: string })
      ?.deviceId;
    if (!route || senderDeviceId !== route.targetDeviceId) return; // 无登记/非目标设备回流,丢弃
    this.queryRoutes.delete(body.correlationId);
    this.emitToRequester(
      route.requester,
      IM_WS_EVENTS.deviceQueryResponse,
      body,
    );
  }

  /**
   * L3 发起方泛化:A 发起远程 run → 校验同账号 + 在线 → 登记 streamId 路由 →
   * 定向下发到目标设备(附 requesterDeviceId)。
   * 离线时直接回 agentRunEnd{reason:offline} 给 requester，不登记路由
   * （A 侧无需再靠超时兜底判定失败）。
   * A 既可能是设备连接（deviceId，room 语义不变），也可能是浏览器用户连接
   * （无 deviceId，requesterDeviceId 编码为 `"user:" + socketId`，B 端原样回填不解析）。
   */
  @SubscribeMessage(IM_WS_EVENTS.agentRunStart)
  @UseGuards(WsAuthGuard)
  async handleAgentRunStart(
    @MessageBody() body: AgentRunStartInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const requesterUserId = (client.data.user as { userId?: string })?.userId;
    const requester = this.requesterOf(client);
    const agent = await this.agents.findActiveById(body.targetAgentId);
    if (!agent || agent.userId !== requesterUserId) return; // 静默拒(A 侧超时兜底)
    const online = await this.devicePresence.isOnline(
      agent.orgId ?? "",
      agent.deviceId,
    );
    if (!online) {
      this.emitToRequester(requester, IM_WS_EVENTS.agentRunEnd, {
        streamId: body.streamId,
        requesterDeviceId: this.encodeRequester(requester),
        reason: "offline",
      } satisfies AgentRunEnd);
      return;
    }
    // 登记同时存 targetAgentId(寻址目标)、targetDeviceId(解出的宿主设备,
    // 回流帧校验/room 定向用) 与 localAgentId(附到 control 转发帧,免每次
    // control 都重新查表)。
    this.agentRunRoutes.set(body.streamId, {
      requester,
      targetAgentId: agent.id,
      targetDeviceId: agent.deviceId,
      localAgentId: agent.localAgentId,
    });
    this.server
      .to(`device:${agent.deviceId}`)
      .emit(IM_WS_EVENTS.agentRunStart, {
        ...body,
        requesterDeviceId: this.encodeRequester(requester),
        localAgentId: agent.localAgentId,
      } satisfies AgentRunStartForwarded);
  }

  /**
   * L3 Phase A:B 侧运行帧回流 → 按 streamId 查路由，校验发送方确为登记的目标设备(B)，
   * 用**登记的** requester 定向回发起方（device 走 room；user 直发 socket）。
   * 仅挂 WsAuthGuard 不够：任何已认证连接都能伪造 requesterDeviceId 向任意
   * device 房间注入帧，故必须比对发送方 = 登记的 targetDeviceId。
   */
  @SubscribeMessage(IM_WS_EVENTS.agentRunFrame)
  @UseGuards(WsAuthGuard)
  async handleAgentRunFrame(
    @MessageBody() body: AgentRunFrame,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    // 本通道（L3 Phase A streamId 单播）尚未消费 watchId 寻址（Agent 级观察通道
    // fan-out 留给后续 Task），缺 streamId 的帧在此路由表下必是非法/未知流。
    if (!body.streamId) return;
    const route = this.agentRunRoutes.get(body.streamId);
    const senderDeviceId = (client.data.user as { deviceId?: string })
      ?.deviceId;
    if (!route || senderDeviceId !== route.targetDeviceId) return; // 仅登记的目标设备(B)可发帧
    this.emitToRequester(route.requester, IM_WS_EVENTS.agentRunFrame, body);
  }

  /**
   * L3 Phase A:B 侧流终止回流 → 校验发送方确为登记的目标设备(B)后，先清理该
   * streamId 的路由登记，再用**登记的** requester 定向回发起方（device 走 room；user 直发 socket）。
   * 同 handleAgentRunFrame：防他人伪造 agent.run.end 提前终止 + 清空路由(DoS)。
   */
  @SubscribeMessage(IM_WS_EVENTS.agentRunEnd)
  @UseGuards(WsAuthGuard)
  async handleAgentRunEnd(
    @MessageBody() body: AgentRunEnd,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const route = this.agentRunRoutes.get(body.streamId);
    const senderDeviceId = (client.data.user as { deviceId?: string })
      ?.deviceId;
    if (!route || senderDeviceId !== route.targetDeviceId) return; // 仅登记的目标设备(B)可终止
    this.agentRunRoutes.delete(body.streamId);
    this.emitToRequester(route.requester, IM_WS_EVENTS.agentRunEnd, body);
  }

  /**
   * L3 发起方泛化:A 侧运行中控制帧(confirm/answer/interrupt) → 按 streamId 查路由，
   * 发起方必须是登记该 streamId 的 requester(kind + id 全等)，否则视为越权/未知流静默拒绝；
   * 通过后定向下发到登记的目标设备(附 requesterDeviceId + localAgentId，
   * localAgentId 取自 handleAgentRunStart 登记时解出的值，不必每条 control
   * 帧都重新查 CloudAgentService——发起方身份已由 sameRequester 校验过，
   * 复用登记值既省一次查表也不改变安全语义)。
   */
  @SubscribeMessage(IM_WS_EVENTS.agentRunControl)
  @UseGuards(WsAuthGuard)
  async handleAgentRunControl(
    @MessageBody() body: AgentRunControlInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const requester = this.requesterOf(client);
    const route = this.agentRunRoutes.get(body.streamId);
    if (!route || !this.sameRequester(route.requester, requester)) return; // 越权/未知拒
    this.server
      .to(`device:${route.targetDeviceId}`)
      .emit(IM_WS_EVENTS.agentRunControl, {
        ...body,
        requesterDeviceId: this.encodeRequester(requester),
        localAgentId: route.localAgentId,
      } satisfies AgentRunControlForwarded);
  }

  /**
   * Agent 级观察通道：观察者发起 watch → 鉴权（同账号 + 设备在线）→ 三表登记
   * → 定向下发到目标设备。
   *
   * 鉴权复用既有范式（同 `handleDeviceQueryRequest` / `handleAgentRunStart`）：
   * `CloudAgentService.findActiveById` + `agent.userId === requesterUserId`。
   * 跨账号**静默拒**（不回包，避免用 watchId 探测他人 Agent 是否存在）；设备
   * 离线**明确回包** `{ok:false, reason:"offline"}`（spec 错误处理：「设备离线 →
   * watch 送不达 → 云端回明确失败，观察者提示，不静默」）。
   */
  @SubscribeMessage(IM_WS_EVENTS.agentWatchStart)
  @UseGuards(WsAuthGuard)
  async handleAgentWatchStart(
    @MessageBody() body: AgentWatchStartInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const requesterUserId = (client.data.user as { userId?: string })?.userId;
    const requester = this.requesterOf(client);
    const agent = await this.agents.findActiveById(body.targetAgentId);
    if (!agent || agent.userId !== requesterUserId) return; // 静默拒（防探测）
    const online = await this.devicePresence.isOnline(
      agent.orgId ?? "",
      agent.deviceId,
    );
    if (!online) {
      this.emitToRequester(requester, IM_WS_EVENTS.agentWatchAccepted, {
        watchId: body.watchId,
        ok: false,
        reason: "offline",
      } satisfies AgentWatchAccepted);
      return;
    }
    this.registerWatch(body.watchId, {
      requester,
      scope: body.scope,
      targetAgentId: agent.id,
      localAgentId: agent.localAgentId,
      targetDeviceId: agent.deviceId,
      sessionId: body.sessionId,
      userId: requesterUserId as string,
    });
    this.server
      .to(`device:${agent.deviceId}`)
      .emit(IM_WS_EVENTS.agentWatchForwarded, {
        watchId: body.watchId,
        localAgentId: agent.localAgentId,
        scope: body.scope,
        sessionId: body.sessionId,
        action: "start",
        requesterDeviceId: this.encodeRequester(requester),
      } satisfies AgentWatchForwarded);
  }

  /**
   * Agent 级观察通道：观察者显式 unwatch（泄漏防线 4）。
   * 只有登记该 watchId 的 requester 本人能注销（`sameRequester` 全等校验），
   * 否则任意已认证连接都能拆别人的观察通道（DoS）。
   */
  @SubscribeMessage(IM_WS_EVENTS.agentWatchStop)
  @UseGuards(WsAuthGuard)
  handleAgentWatchStop(
    @MessageBody() body: AgentWatchStopInput,
    @ConnectedSocket() client: Socket,
  ): void {
    const route = this.watchRoutes.get(body.watchId);
    if (!route) return;
    if (!this.sameRequester(route.requester, this.requesterOf(client))) return;
    this.unregisterWatch(body.watchId, true);
  }

  /**
   * Agent 级观察通道：被观察设备上行镜像帧 → 按反向索引 fan-out 给全部观察者。
   *
   * 设备**只上行一份**（不带 watchId，它不知道有几个观察者），本网关按
   * `${senderDeviceId}:${localAgentId}`（agent scope）或
   * `${senderDeviceId}:${sessionId}`（session scope）查索引，扇出成 N 份
   * **带 watchId、不带 streamId** 的 `AgentRunFrame`——前端 tracker 据此走
   * 「观察」通道而非「自己发起的流」通道。
   *
   * 索引键用**发送方连接的 deviceId**（`client.data.user.deviceId`）而非帧里
   * 任何字段：与 `handleAgentRunFrame` 的安全语义一致——任何已认证连接都能
   * 伪造帧体，只有连接层身份可信。伪造方查不到自己名下的索引键，帧被静默丢弃。
   *
   * 索引 Set 反查主表 miss（悬挂项，理论上不应发生——`registerWatch` 已保证
   * 幂等一致）时防御性 `continue` 跳过该条，不影响其余观察者收帧，不抛异常。
   */
  @SubscribeMessage(IM_WS_EVENTS.agentWatchFrame)
  @UseGuards(WsAuthGuard)
  handleAgentWatchFrame(
    @MessageBody() body: AgentWatchFrame,
    @ConnectedSocket() client: Socket,
  ): void {
    const senderDeviceId = (client.data.user as { deviceId?: string })
      ?.deviceId;
    if (!senderDeviceId) return; // 非设备连接不得上行镜像帧
    const key =
      body.scope === "agent"
        ? ImGateway.agentWatchKey(senderDeviceId, body.localAgentId)
        : ImGateway.sessionWatchKey(senderDeviceId, body.sessionId ?? "");
    const index =
      body.scope === "agent" ? this.agentWatchers : this.sessionWatchers;
    const watchIds = index.get(key);
    if (!watchIds || watchIds.size === 0) return; // 无观察者，丢弃
    for (const watchId of watchIds) {
      const route = this.watchRoutes.get(watchId);
      if (!route) {
        // 当前不变量下不可达：三表唯一写入口是 registerWatch/unregisterWatch，
        // 二者同步无 await，不存在「索引已加、主表未加」的中间态。
        // 留 warn 作哨兵——本类的 Map 是**进程内**的，将来 server-main 多实例
        // 部署若没把这三张表迁到共享存储，这条会从「不可达」变成「真实发生但
        // 完全无信号的静默丢帧」，正是最难查的那类症状。
        this.logger.warn(
          `watch 索引存在但主表缺失（watchId=${watchId}），跳过该观察者`,
        );
        continue;
      }
      // 有帧活动即续期：idle 清扫按 lastActiveAt 判定，正被扇出的 watch 不该
      // 因为「没显式续期动作」而在下一次 sweep 被误回收。
      route.lastActiveAt = Date.now();
      this.emitToRequester(route.requester, IM_WS_EVENTS.agentRunFrame, {
        watchId,
        requesterDeviceId: this.encodeRequester(route.requester),
        seq: body.seq,
        sessionId: body.sessionId ?? "",
        event: body.event,
        payload: body.payload,
      } satisfies AgentRunFrame);
    }
  }

  /**
   * Agent 级观察通道：被观察设备回发受理包 → 按登记的 requester 定向回单个
   * 观察者（**不广播**：inflight 快照是该 watchId 独有的续上数据）。
   *
   * 发送方必须是登记的 targetDeviceId（同 `handleAgentRunFrame` 的防伪造语义）。
   * `ok:false` 时转发之后**立即注销该 watch**——设备已经明确拒绝（Agent 不可
   * 远程 / 会话不归它 / 内部错误），留着路由只会让后续帧扇给一个不存在的观察
   * 关系，属于泄漏。
   */
  @SubscribeMessage(IM_WS_EVENTS.agentWatchAccepted)
  @UseGuards(WsAuthGuard)
  handleAgentWatchAccepted(
    @MessageBody() body: AgentWatchAccepted,
    @ConnectedSocket() client: Socket,
  ): void {
    const route = this.watchRoutes.get(body.watchId);
    const senderDeviceId = (client.data.user as { deviceId?: string })
      ?.deviceId;
    if (!route || senderDeviceId !== route.targetDeviceId) return;
    this.emitToRequester(
      route.requester,
      IM_WS_EVENTS.agentWatchAccepted,
      body,
    );
    if (!body.ok) {
      // 设备拒了：转发后立即注销，不留悬挂路由（notifyDevice=false——设备
      // 自己就是拒绝方，再回一条 stop 是噪音）。
      this.unregisterWatch(body.watchId, false);
    }
  }

  /**
   * 浏览器在线态上报（server-agent 按浏览器连接数聚合后发）。
   * online → setOnline + 广播；offline → setOffline + 广播。
   *
   * 竞态修复：relay 一连上就立即 emit presence_set，而 onAuthedConnect 是异步的，
   * orgId 可能尚未落到 client.data。若缺失则就地从 userService 解析并回写，
   * 避免登录初次竞态导致上线事件被静默丢弃。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.presenceSet)
  async handlePresenceSet(
    @MessageBody() body: ImPresenceSetInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const userId: string = client.data.user.userId;
    let orgId: string | undefined = client.data?.orgId;
    if (!orgId) {
      // presence_set 可能早于 onAuthedConnect 落定 orgId（relay 一连上就上报）；就地解析。
      orgId = await this.resolveOrgId(client);
      if (orgId) client.data.orgId = orgId;
    }
    if (!orgId) return;
    if (body.online) {
      await this.presence.setOnline(orgId, userId);
    } else {
      await this.presence.setOffline(orgId, userId);
    }
    this.server.to(`org:${orgId}`).emit(IM_WS_EVENTS.presence, {
      userId,
      online: body.online,
    } satisfies PresenceState);
  }

  /**
   * Keepalive ping：续期 presence TTL。
   * server-agent 每 ~20s 发一次（设备连着 server-main 就发，不再依赖是否有浏览器
   * 在线），防止 TTL（45s）到期被误判离线。
   * device 连接（payload 带 deviceId）额外续期设备级 presence
   * （`devicePresence.heartbeat`，orgId 与 onAuthedConnect 的 setOnline 同源，
   * 取 `client.data.orgId`），且**无条件**执行（headless agent 无浏览器也要维持
   * 设备级在线）。
   *
   * 终审复核 FIX B：用户级 `presence.heartbeat` **不再无条件执行**——只在该用户
   * 当前已在线（`presence.isOnline`）时才续期，不会用 ping 把一个已被显式
   * `setOffline`（浏览器关闭 → `handlePresenceSet({online:false})`）的用户重新
   * 续活，恢复"用户级在线 = 有浏览器在看 IM"的门控语义；用户级与设备级两个
   * presence 互不覆盖。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.ping)
  async handlePing(@ConnectedSocket() client: Socket): Promise<void> {
    const orgId: string | undefined = client.data?.orgId;
    if (!orgId) return;
    const deviceId = (client.data?.user as { deviceId?: string })?.deviceId;
    if (deviceId) {
      await this.devicePresence.heartbeat(orgId, deviceId);
    }
    const userId: string = client.data.user.userId;
    if (await this.presence.isOnline(orgId, userId)) {
      await this.presence.heartbeat(orgId, userId);
    }
  }

  /**
   * 新会话建立事件（EventEmitter2）。
   *
   * ImController (B7) 建频道 / DM 后 emit：
   * ```ts
   * eventEmitter.emit(IM_WS_EVENTS.conversationCreated, {
   *   summary, userIds, orgId,
   * });
   * ```
   *
   * 本 handler：
   * 1. fetchSockets 获取 org 房间内所有连接
   * 2. 过滤 userId 在 payload.userIds 中的连接
   * 3. 这些连接 join conv 房间 + emit conversationCreated 事件
   */
  /** org 模型配置变更 → 广播给该 org 全部在线连接（设备收到即全量重同步）。 */
  @OnEvent(ORG_MODEL_CONFIG_EVENTS.changed)
  onOrgModelConfigChanged(payload: OrgModelConfigChangedEvent): void {
    try {
      this.server
        .to(`org:${payload.orgId}`)
        .emit(IM_WS_EVENTS.modelConfigChanged, {});
    } catch (err) {
      this.logger.error("im onOrgModelConfigChanged failed", err as Error);
    }
  }

  /**
   * 云端 Agent 注册表变更（Bug #12 修复）：设备侧开关「允许远程」触发全量对账，
   * `CloudAgentService.syncForDevice` 产生实际写入（新增/改名/复活/软删）后
   * emit 本事件 → 定向广播给该用户（`userId`）的全部在线连接，web-main
   * 收到即 `invalidateQueries` 重新拉取 `GET /api/agents`，免手动刷新页面。
   *
   * 按 org 房间取连接后按 userId 过滤（同 `handleRead` 的写法）——CloudAgent
   * 无独立房间，复用已有的 org room 广播 + 客户端过滤模式，不新起基础设施。
   * `orgId` 为 null（设备/用户尚未归属组织的边缘情况）时无房间可投，跳过实时
   * 推送，退化为下次用户操作触发的被动重拉（不阻塞主链路）。
   */
  @OnEvent(CLOUD_AGENT_EVENTS.changed)
  async onCloudAgentChanged(payload: CloudAgentChangedEvent): Promise<void> {
    try {
      if (!payload.orgId) return;
      const sockets = await this.server
        .in(`org:${payload.orgId}`)
        .fetchSockets();
      for (const s of sockets) {
        if (s.data.user?.userId === payload.userId) {
          s.emit(IM_WS_EVENTS.agentRegistryChanged, {});
        }
      }
    } catch (err) {
      this.logger.error("im onCloudAgentChanged failed", err as Error);
    }
  }

  @OnEvent(IM_WS_EVENTS.conversationCreated)
  async onConversationCreated(payload: {
    summary: ConversationSummary;
    userIds: string[];
    orgId: string;
  }): Promise<void> {
    try {
      const { summary, userIds, orgId } = payload;
      const sockets = await this.server.in(`org:${orgId}`).fetchSockets();
      for (const s of sockets) {
        if (userIds.includes(s.data.user?.userId)) {
          s.join(`conv:${summary.id}`);
          s.emit(IM_WS_EVENTS.conversationCreated, summary);
        }
      }
    } catch (err) {
      this.logger.error("im onConversationCreated failed", err as Error);
    }
  }

  /** 成员退出私有频道：让其在线 socket 离开 conv 房间并下发移除通知。 */
  @OnEvent(IM_WS_EVENTS.conversationRemoved)
  async onConversationRemoved(payload: {
    conversationId: string;
    userId: string;
    orgId: string;
  }): Promise<void> {
    try {
      const { conversationId, userId, orgId } = payload;
      const sockets = await this.server.in(`org:${orgId}`).fetchSockets();
      for (const s of sockets) {
        if (s.data.user?.userId === userId) {
          s.leave(`conv:${conversationId}`);
          s.emit(IM_WS_EVENTS.conversationRemoved, { conversationId });
        }
      }
    } catch (err) {
      this.logger.error("im onConversationRemoved failed", err as Error);
    }
  }
}
