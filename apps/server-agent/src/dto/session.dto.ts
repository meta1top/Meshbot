import { createZodDto } from "@meshbot/common";
import { AppendMessageSchema, CreateSessionSchema } from "@meshbot/types-agent";

/** POST /api/sessions 入参 DTO。 */
export class CreateSessionDto extends createZodDto(CreateSessionSchema) {}

/** POST /api/sessions/:id/messages 入参 DTO。 */
export class AppendMessageDto extends createZodDto(AppendMessageSchema) {}
