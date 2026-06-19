import { z } from "zod";
import { SessionSummarySchema } from "./session";

/**
 * ConversationSummary 对应的 Zod schema（镜像 @meshbot/types 中的同名 interface）。
 * 放此处以便 createZodDto 生成 Swagger DTO，且避免 libs/types 引入 zod 依赖。
 */
export const ConversationSummarySchema = z.object({
  id: z.string(),
  type: z.enum(["channel", "dm"]),
  visibility: z.enum(["public", "private"]),
  name: z.string().nullable(),
  peer: z
    .object({
      userId: z.string(),
      displayName: z.string(),
      email: z.string(),
    })
    .nullable(),
  unreadCount: z.number(),
  lastMessage: z
    .object({
      content: z.string(),
      senderId: z.string(),
      createdAt: z.string(),
    })
    .nullable(),
});

/** GET /api/sidebar 出参 schema。 */
export const SidebarResponseSchema = z.object({
  /** 云端频道 + 私信会话（云端故障时降级为空数组）。 */
  conversations: z.array(ConversationSummarySchema),
  /** 本地 Agent 助手会话列表（按 pinned 优先 + updatedAt 降序排序）。 */
  sessions: z.array(SessionSummarySchema),
});
export type SidebarResponse = z.infer<typeof SidebarResponseSchema>;
