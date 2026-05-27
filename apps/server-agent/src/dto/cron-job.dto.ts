import { createZodDto } from "@meshbot/common";
import { CreateCronJobSchema, PatchCronJobSchema } from "@meshbot/types-agent";

export class CreateCronJobDto extends createZodDto(CreateCronJobSchema) {}
export class PatchCronJobDto extends createZodDto(PatchCronJobSchema) {}
