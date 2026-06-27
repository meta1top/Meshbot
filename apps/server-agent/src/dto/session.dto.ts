import { createZodDto } from "@meshbot/common";
import {
  AppendMessageSchema,
  CreateSessionSchema,
  MessageFeedbackSchema,
  SessionListResponseSchema,
  SessionPatchSchema,
  SessionSummarySchema,
  confirmToolCallSchema,
} from "@meshbot/types-agent";

/** POST /api/sessions 入参 DTO。 */
export class CreateSessionDto extends createZodDto(CreateSessionSchema) {}

/** POST /api/sessions/:id/messages 入参 DTO。 */
export class AppendMessageDto extends createZodDto(AppendMessageSchema) {}

/** PATCH /api/sessions/:id 入参 DTO（title / pinned 至少传一项）。 */
export class SessionPatchDto extends createZodDto(SessionPatchSchema) {}

/** POST /api/sessions/:id/messages/:messageId/feedback 入参 DTO。 */
export class MessageFeedbackDto extends createZodDto(MessageFeedbackSchema) {}

/** 单会话概要响应 DTO（Swagger 类型声明用）。 */
export class SessionSummaryDto extends createZodDto(SessionSummarySchema) {}

/** 会话列表响应 DTO（Swagger 类型声明用）。 */
export class SessionListResponseDto extends createZodDto(
  SessionListResponseSchema,
) {}

/** POST /api/sessions/:sessionId/confirm 入参 DTO（send/cancel 工具调用确认）。 */
export class ConfirmToolCallDto extends createZodDto(confirmToolCallSchema) {}
