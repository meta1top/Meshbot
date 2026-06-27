import { z } from "zod";

/** POST /api/sessions/:sessionId/confirm 请求体：确认/取消一次待审批的工具调用。 */
export const confirmToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  decision: z.enum(["send", "cancel"]),
  content: z.string().optional(),
});
export type ConfirmToolCallInput = z.infer<typeof confirmToolCallSchema>;
