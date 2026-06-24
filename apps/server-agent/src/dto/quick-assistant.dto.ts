import { createZodDto } from "@meshbot/common";
import { renameQuickAssistantSchema } from "@meshbot/types-agent";

/** 随手问改名请求体（PATCH /api/quick-assistant/name）。 */
export class RenameQuickAssistantDto extends createZodDto(
  renameQuickAssistantSchema,
) {}
