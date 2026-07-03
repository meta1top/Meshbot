import { z } from "zod";

export type ConversationType = "channel" | "dm";

export const ImMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  senderId: z.string(),
  content: z.string(),
  createdAt: z.string(), // ISO
  senderType: z.enum(["user", "agent"]), // 发送者类型：人类用户 or 设备 Agent
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
  agentDeviceId: string | null; // 非空即"人↔设备 Agent"的 DM；channel/普通 dm 为 null
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
