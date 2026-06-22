import { createZodDto } from "@meshbot/common";
import {
  InstallSkillSchema,
  PublishLocalSkillSchema,
} from "@meshbot/types-agent";

export class InstallSkillDto extends createZodDto(InstallSkillSchema) {}
export class PublishLocalSkillDto extends createZodDto(
  PublishLocalSkillSchema,
) {}
