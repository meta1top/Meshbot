import { createZodDto } from "@meshbot/common";
import { PublishSkillSchema } from "@meshbot/types-main";

/** POST /api/skills 入参。 */
export class PublishSkillDto extends createZodDto(PublishSkillSchema) {}
