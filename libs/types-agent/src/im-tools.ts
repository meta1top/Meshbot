import { z } from "zod";

/** im_read_conversation 入参。 */
export const imReadConversationSchema = z.object({
  conversationId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  before: z.string().optional(),
});
export type ImReadConversationInput = z.infer<typeof imReadConversationSchema>;

/** im_list_members 入参。 */
export const imListMembersSchema = z.object({
  conversationId: z.string().min(1),
});
export type ImListMembersInput = z.infer<typeof imListMembersSchema>;

/** im_unread_overview 入参（无参）。 */
export const imUnreadOverviewSchema = z.object({});
export type ImUnreadOverviewInput = z.infer<typeof imUnreadOverviewSchema>;

/** im_send_message 入参（写侧；发出前经用户确认）。 */
export const imSendMessageSchema = z.object({
  conversationId: z.string().min(1),
  content: z.string().min(1),
});
export type ImSendMessageInput = z.infer<typeof imSendMessageSchema>;
