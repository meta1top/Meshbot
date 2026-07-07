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

/** 跨设备只读查询的种类:列会话 / 取某会话历史 */
export const DeviceQueryKindSchema = z.enum(["sessions", "history"]);
export type DeviceQueryKind = z.infer<typeof DeviceQueryKindSchema>;

/** A→云 的设备查询请求(上行,需服务端校验) */
export const DeviceQueryRequestSchema = z.object({
  correlationId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  kind: DeviceQueryKindSchema,
  params: z
    .object({
      sessionId: z.string().optional(),
      before: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .default({}),
});
export type DeviceQueryRequestInput = z.infer<typeof DeviceQueryRequestSchema>;

/** 云网关转发给目标设备时附加发起方 deviceId */
export interface DeviceQueryForwarded extends DeviceQueryRequestInput {
  requesterDeviceId: string;
}

/** 设备查询响应(B→云→A);data 按 kind 由 A 侧断言(sessions→SessionSummary[] / history→HistoryResponse) */
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
  targetDeviceId: z.string().min(1),
  mode: z.enum(["create", "append"]),
  sessionId: z.string().optional(),
  content: z.string(),
});
export type AgentRunStartInput = z.infer<typeof AgentRunStartSchema>;
export interface AgentRunStartForwarded extends AgentRunStartInput {
  requesterDeviceId: string;
}

/** L3:A→B 运行中控制(confirm/answer/interrupt)。 */
export const AgentRunControlSchema = z.object({
  streamId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  sessionId: z.string().min(1),
  kind: z.enum(["confirm", "answer", "interrupt"]),
  toolCallId: z.string().optional(),
  decision: z.enum(["send", "cancel"]).optional(),
  content: z.string().optional(),
  answers: z.array(z.string()).optional(),
});
export type AgentRunControlInput = z.infer<typeof AgentRunControlSchema>;
export interface AgentRunControlForwarded extends AgentRunControlInput {
  requesterDeviceId: string;
}

/** L3:B→A 运行帧(透传 SESSION_WS_EVENTS.* payload;event 用其常量字符串)。 */
export interface AgentRunFrame {
  streamId: string;
  requesterDeviceId: string;
  seq: number;
  sessionId: string;
  event: string;
  payload: unknown;
}
/** L3:B→A 流终止。 */
export interface AgentRunEnd {
  streamId: string;
  requesterDeviceId: string;
  reason: "done" | "error" | "interrupted" | "offline";
}
