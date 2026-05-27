import { createZodDto } from "@meshbot/common";
import {
  AppendMessageSchema,
  CreateSessionSchema,
  MessageFeedbackSchema,
  SessionPatchSchema,
} from "@meshbot/types-agent";

/** POST /api/sessions 入参 DTO。 */
export class CreateSessionDto extends createZodDto(CreateSessionSchema) {}

/** POST /api/sessions/:id/messages 入参 DTO。 */
export class AppendMessageDto extends createZodDto(AppendMessageSchema) {}

/** PATCH /api/sessions/:id 入参 DTO（title / pinned 至少传一项）。 */
export class SessionPatchDto extends createZodDto(SessionPatchSchema) {}

/** POST /api/sessions/:id/messages/:messageId/feedback 入参 DTO。 */
export class MessageFeedbackDto extends createZodDto(MessageFeedbackSchema) {}
