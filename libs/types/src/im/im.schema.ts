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

export interface ConversationSummary {
  id: string;
  type: ConversationType;
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
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

export const CreateDmSchema = z.object({ userId: z.string() });
export type CreateDmInput = z.infer<typeof CreateDmSchema>;
