import { z } from "zod";

export type ConversationType = "channel" | "dm";

export const ImMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  senderId: z.string(),
  content: z.string(),
  createdAt: z.string(), // ISO
});
export type ImMessage = z.infer<typeof ImMessageSchema>;

export interface ImPeer {
  userId: string;
  displayName: string;
  email: string;
}

export interface ChannelMember {
  userId: string;
  displayName: string;
  email: string;
}

export interface ConversationSummary {
  id: string;
  type: ConversationType;
  visibility: "public" | "private"; // channel 的可见性；dm 取 "private"
  name: string | null; // 频道名；dm 为 null
  peer: ImPeer | null; // dm 的对端；channel 为 null
  unreadCount: number;
  lastMessage: { content: string; senderId: string; createdAt: string } | null;
}

export interface PresenceState {
  userId: string;
  online: boolean;
}

// 上行入参
export const ImSendSchema = z.object({
  conversationId: z.string(),
  content: z.string().min(1).max(8000),
});
export type ImSendInput = z.infer<typeof ImSendSchema>;

export const ImReadSchema = z.object({ conversationId: z.string() });
export type ImReadInput = z.infer<typeof ImReadSchema>;

// REST 入参
export const CreateChannelSchema = z.object({
  name: z.string().min(1).max(64),
  visibility: z.enum(["public", "private"]).default("public"),
  memberIds: z.array(z.string()).optional(),
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

export const CreateDmSchema = z.object({ userId: z.string() });
export type CreateDmInput = z.infer<typeof CreateDmSchema>;

export const AddChannelMemberSchema = z.object({ userId: z.string() });
export type AddChannelMemberInput = z.infer<typeof AddChannelMemberSchema>;

/**
 * 跨设备查询/操作的种类:列会话 / 取某会话历史 / 改会话模型。
 * patch-session-model 是本通道首个写操作——模型配置由云端 Org 统一下发且
 * 本地行 id=云端配置 id(跨设备一致),A 侧下拉选的 id 可直接写对端会话。
 */
export const DeviceQueryKindSchema = z.enum([
  "sessions",
  "history",
  "patch-session-model",
  "artifact-file",
  "artifact-upload-drive",
]);
export type DeviceQueryKind = z.infer<typeof DeviceQueryKindSchema>;

/** A→云 的设备查询请求(上行,需服务端校验) */
export const DeviceQueryRequestSchema = z.object({
  correlationId: z.string().min(1),
  /** 目标云端 Agent id(计划二 2b:寻址从设备细化到设备上的某 Agent)。 */
  targetAgentId: z.string().min(1),
  kind: DeviceQueryKindSchema,
  params: z
    .object({
      sessionId: z.string().optional(),
      before: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      /** patch-session-model 用:目标模型配置 id(云端配置 id,跨设备一致)。 */
      modelConfigId: z.string().optional(),
      /** artifact-file / artifact-upload-drive 用:产物工作区相对路径。 */
      filePath: z.string().optional(),
    })
    .default({}),
});
export type DeviceQueryRequestInput = z.infer<typeof DeviceQueryRequestSchema>;

/**
 * 云网关转发给目标设备时附加发起方标识 + 目标设备上的本地 Agent id。
 * device 发起：deviceId 原值；浏览器 user 发起（L3 发起方泛化）：`"user:" + socketId`
 * （server-main 内部编码，B 端原样回填不解析）。
 * localAgentId：网关按 targetAgentId 查云端 Agent 行解出的 `localAgentId`，
 * B 侧据此定位本地哪个 Agent（不是 targetAgentId 本身——那是云端另发的 id）。
 */
export interface DeviceQueryForwarded extends DeviceQueryRequestInput {
  requesterDeviceId: string;
  localAgentId: string;
}

/**
 * 设备查询响应(B→云→A);data 按 kind 由 A 侧断言(sessions→SessionSummary[] / history→HistoryResponse)。
 * requesterDeviceId 同上：device 发起为 deviceId，user 发起为 `"user:" + socketId`。
 */
export interface DeviceQueryResponse {
  correlationId: string;
  requesterDeviceId: string;
  ok: boolean;
  reason?: "offline" | "cross_account" | "error";
  data?: unknown;
}

/** L3:A→B 触发远程 run。create 由 B 新建会话并经首帧回报 sessionId;append 带 B 上会话 id。 */
export const AgentRunStartSchema = z.object({
  streamId: z.string().min(1),
  /** 目标云端 Agent id(计划二 2b:寻址从设备细化到设备上的某 Agent)。 */
  targetAgentId: z.string().min(1),
  mode: z.enum(["create", "append"]),
  sessionId: z.string().optional(),
  content: z.string(),
});
export type AgentRunStartInput = z.infer<typeof AgentRunStartSchema>;
/**
 * requesterDeviceId：device 发起为 deviceId，浏览器 user 发起（L3 发起方泛化）
 * 为 `"user:" + socketId`（server-main 内部编码，B 端原样回填不解析）。
 * localAgentId：网关按 targetAgentId 查云端 Agent 行解出的 `localAgentId`，
 * B 侧据此建会话应归属哪个本地 Agent。
 */
export interface AgentRunStartForwarded extends AgentRunStartInput {
  requesterDeviceId: string;
  localAgentId: string;
}

/**
 * 远程 ask_question 回答项。镜像 `@meshbot/types-agent` 的 `answerItemSchema`
 *（libs/types 不能反向依赖 types-agent,故就地重定义;形状须与其保持一致）。
 */
export const AgentRunAnswerItemSchema = z.object({
  selected: z.array(z.string()),
  other: z.string().optional(),
});
export type AgentRunAnswerItem = z.infer<typeof AgentRunAnswerItemSchema>;

/**
 * L3:A→B 运行中控制(confirm/answer/interrupt)。
 *
 * **双寻址（Agent 级观察通道 D2：观察者也能应答 HITL）**：`streamId` 与
 * `watchId` **二选一必填**（同 {@link AgentRunFrameSchema} 的双寻址）：
 * - `streamId`：自己发起的流（既有语义，不变）；
 * - `watchId`：观察中的通道——观察者据此应答别人发起的 run 挂起的 HITL 关卡。
 *   **不可携带 `kind:"interrupt"`**——打断权限仍限发起方（spec「不在本轮」：
 *   观察者只能应答 HITL，不能打断）。
 */
export const AgentRunControlSchema = z
  .object({
    /** 自己发起的流；与 watchId 二选一必填。 */
    streamId: z.string().min(1).optional(),
    /**
     * 观察中的通道（Agent 级观察通道 D2：观察者也能应答 HITL）；与 streamId
     * 二选一必填。**不可携带 `kind:"interrupt"`**——打断权限仍限发起方
     * （spec「不在本轮」：观察者只能应答 HITL）。
     */
    watchId: z.string().min(1).optional(),
    /** 目标云端 Agent id(计划二 2b:寻址从设备细化到设备上的某 Agent)。 */
    targetAgentId: z.string().min(1),
    sessionId: z.string().min(1),
    kind: z.enum(["confirm", "answer", "interrupt"]),
    toolCallId: z.string().optional(),
    decision: z.enum(["send", "cancel"]).optional(),
    content: z.string().optional(),
    answers: z.array(AgentRunAnswerItemSchema).optional(),
  })
  .refine((v) => !!v.streamId !== !!v.watchId, {
    message: "streamId 与 watchId 二选一必填",
  })
  .refine((v) => !(v.watchId && v.kind === "interrupt"), {
    message: "观察者不可中断他人发起的 run（打断权限限发起方）",
    path: ["kind"],
  });
export type AgentRunControlInput = z.infer<typeof AgentRunControlSchema>;
/**
 * requesterDeviceId 同 AgentRunStartForwarded：device 为 deviceId，user 为 `"user:" + socketId`。
 * localAgentId 同 AgentRunStartForwarded：网关按 targetAgentId 解出的目标设备本地 Agent id。
 */
export interface AgentRunControlForwarded extends AgentRunControlInput {
  requesterDeviceId: string;
  localAgentId: string;
}

/**
 * L3:B→A 运行帧(透传 SESSION_WS_EVENTS.* payload;event 用其常量字符串)。
 *
 * **双寻址（Agent 级观察通道）**：`streamId` 与 `watchId` **二选一必填**：
 * - `streamId`：接收方自己发起的远程 run 流（既有语义，不变）；
 * - `watchId`：接收方**观察**的流——云端按 `sessionWatchers` fan-out 时填入，
 *   设备侧上行的 `AgentWatchFrame` 本身不带 watchId（设备只发一份）。
 *
 * 两个都带 = 寻址歧义（前端 tracker 无法判定该走 streamId 还是 watchId 通道），
 * 两个都不带 = 无法路由，均判非法。
 *
 * requesterDeviceId 由 B 端原样回填 agentRunStart 收到的值，不解析（device 为
 * deviceId，浏览器 user 发起时为 `"user:" + socketId`）；watchId 寻址时由云端
 * fan-out 时填入登记的 requester 编码。
 */
export const AgentRunFrameSchema = z
  .object({
    streamId: z.string().min(1).optional(),
    watchId: z.string().min(1).optional(),
    requesterDeviceId: z.string(),
    seq: z.number().int().nonnegative(),
    sessionId: z.string(),
    event: z.string(),
    payload: z.unknown(),
  })
  .refine((v) => !!v.streamId !== !!v.watchId, {
    message: "streamId 与 watchId 二选一必填（不可同时缺省或同时提供）",
  });
export type AgentRunFrame = z.infer<typeof AgentRunFrameSchema>;
/**
 * L3:B→A 流终止。requesterDeviceId 同 AgentRunFrame，由 B 端原样回填。
 * B 侧二次门控的两条拒绝理由**必须分开**——它们对用户是完全不同的事实，合成
 * 一条会把排查（和前端文案）带偏：
 *
 * - `agent_not_remotable`：`forwarded.localAgentId` 指向的本地 Agent **不存在**，
 *   或其 `remote_enabled` 非 true。（B 侧不信云端下发的 targetAgentId / 云端
 *   Agent 行状态，本地 remote_enabled 才是唯一真相；云端登记可能过期。）
 * - `session_agent_mismatch`：append 模式下 `forwarded.sessionId` 查无，或该会话
 *   真正归属的 `session.agentId` 不等于 `localAgentId`——Agent 本身是可远程的，
 *   只是这个会话不归它。真正执行 run 的是 session.agentId，不能只查 localAgentId
 *   的 remote_enabled 就放行，否则可拿任一 remote_enabled Agent 当跳板越权唤醒
 *   别的会话归属、已被关闭远程开关的 Agent。
 */
export interface AgentRunEnd {
  streamId: string;
  requesterDeviceId: string;
  reason:
    | "done"
    | "error"
    | "interrupted"
    | "offline"
    | "agent_not_remotable"
    | "session_agent_mismatch";
}
