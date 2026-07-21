import { z } from "zod";

/**
 * watch 粒度（spec D8）：
 * - `agent`：订该 Agent 的会话生命周期（新建/删除/改名/状态变化，低频）
 * - `session`：订某个会话的推理帧（`SESSION_WS_EVENTS.*` 全集，高频）
 *
 * 两级共用同一套协议与同一个 watchId 命名空间（云端 `watchRoutes` 一张表，
 * 靠本字段区分）；同一客户端进入 Agent 拿一个 agent-scope watchId、打开会话
 * 再拿一个 session-scope watchId，是**两个独立 id**。
 */
export const WatchScopeSchema = z.enum(["agent", "session"]);
export type WatchScope = z.infer<typeof WatchScopeSchema>;

/**
 * 观察者 → 云端：发起 watch（上行，需服务端鉴权）。
 * watchId 由客户端生成（雪花/uuid），云端只做唯一键用途不解析语义。
 * `scope:"session"` 时 sessionId 必填——Session 级 watch 精确到一个会话，
 * 缺 sessionId 云端无法建 `sessionWatchers` 索引。
 */
export const AgentWatchStartSchema = z
  .object({
    watchId: z.string().min(1),
    /** 目标云端 Agent id（同 `AgentRunStartSchema.targetAgentId`）。 */
    targetAgentId: z.string().min(1),
    scope: WatchScopeSchema,
    /** scope="session" 时必填：被观察会话在目标设备上的 id。 */
    sessionId: z.string().min(1).optional(),
  })
  .refine((v) => v.scope !== "session" || !!v.sessionId, {
    message: "scope=session 必须携带 sessionId",
    path: ["sessionId"],
  });
export type AgentWatchStartInput = z.infer<typeof AgentWatchStartSchema>;

/** 观察者 → 云端：显式 unwatch（离开 Agent / 关闭会话）。 */
export const AgentWatchStopSchema = z.object({
  watchId: z.string().min(1),
});
export type AgentWatchStopInput = z.infer<typeof AgentWatchStopSchema>;

/**
 * 云端 → 设备：转发 watch 登记 / 注销。
 * `localAgentId` 是云端按 targetAgentId 查 CloudAgent 表解出的目标设备本地
 * Agent id——设备只认自己的本地 id，绝不认云端 id（同 `AgentRunStartForwarded`）。
 * `requesterDeviceId` 编码同 `AgentRunStartForwarded`：device 为 deviceId，
 * 浏览器 user 为 `"user:" + socketId`，设备端原样回填不解析。
 */
export const AgentWatchForwardedSchema = z.object({
  watchId: z.string().min(1),
  localAgentId: z.string().min(1),
  scope: WatchScopeSchema,
  sessionId: z.string().min(1).optional(),
  action: z.enum(["start", "stop"]),
  requesterDeviceId: z.string().min(1),
});
export type AgentWatchForwarded = z.infer<typeof AgentWatchForwardedSchema>;

/**
 * 设备 → 云端 → 观察者：watch 受理回包。
 * `scope:"session"` 且 ok 时携带 `inflight` 快照（spec D7），观察者据此渲染
 * 半截输出续上正在跑的 run。形状是 server-agent 的 `InflightView`——`libs/types`
 * 不能反向依赖 `libs/types-agent`，故此处按 `unknown` 透传，观察者侧断言
 * （同 `DeviceQueryResponse.data` 的既有做法，见 `im.schema.ts:115-121`）。
 */
export const AgentWatchAcceptedSchema = z.object({
  watchId: z.string().min(1),
  ok: z.boolean(),
  /**
   * 拒绝原因。**「身份维度」与「会话归属维度」必须分开**——它们对用户是完全
   * 不同的事实，合成一条会把排查与前端文案带偏（本仓 `AgentRunEnd.reason` 曾
   * 因 `agent_not_remotable` 一值承载三种事实，害过一整轮真机排查）。
   * - `offline` / `cross_account`：云端网关（`im.gateway` 的 watchRoutes）语义，转发前即拒。
   * - `not_found`：设备侧身份维度——目标 Agent 查无 **或** 未开远程（与
   *   `AgentRunEnd.agent_not_remotable` 同粒度，不再细拆）。
   * - `session_agent_mismatch`：设备侧会话归属维度——缺 sessionId / 会话查无 /
   *   会话不归属该 Agent。字面量刻意与 `AgentRunEnd.reason` 同名，跨协议一致。
   * - `error`：设备侧处理异常。
   * - `idle`：云端网关语义——通道长时间（`WATCH_IDLE_MS`）无帧活动被
   *   `sweepIdleWatches` 回收。刻意与 `offline` 分开：宿主设备大概率仍在线，
   *   只是这条通道没数据，语义完全不同——`offline` 是「设备真的不在了」，
   *   `idle` 是「设备在，只是这条通道太久没动静」。观察者收到 `idle` 应
   *   自动重新发起 watch（见 `session-transport.ts` `handleWatchRejected`），
   *   不该像 `offline` 那样弹横幅等用户手动救。
   */
  reason: z
    .enum([
      "offline",
      "cross_account",
      "not_found",
      "session_agent_mismatch",
      "error",
      "idle",
    ])
    .optional(),
  inflight: z.unknown().optional(),
});
export type AgentWatchAccepted = z.infer<typeof AgentWatchAcceptedSchema>;

/**
 * 设备 → 云端：镜像帧（**每个 agent / 每个 session 只发一份**，云端按
 * `agentWatchers` / `sessionWatchers` 索引表 fan-out 成一份份带 watchId 的
 * `AgentRunFrame` 下发各观察者，见 spec §C 取舍）。
 *
 * 故本结构**不带 watchId**——设备发帧时不知道有几个观察者，也不该知道。
 * `event` 用 `z.string()` 透传事件名（`SESSION_WS_EVENTS.*` 或
 * `session.created` 等生命周期事件常量值）：`libs/types` 禁止反向依赖
 * `libs/types-agent`，与既有 `AgentRunFrame.event` 同构。
 */
export const AgentWatchFrameSchema = z.object({
  localAgentId: z.string().min(1),
  scope: WatchScopeSchema,
  /** scope="session" 时为该会话 id；scope="agent" 的生命周期帧可缺省。 */
  sessionId: z.string().min(1).optional(),
  seq: z.number().int().nonnegative(),
  event: z.string().min(1),
  payload: z.unknown(),
});
export type AgentWatchFrame = z.infer<typeof AgentWatchFrameSchema>;
