import { createZodDto } from "@meshbot/common";
import {
  modelConfigEnabledSchema,
  modelConfigSchema,
  modelConfigUpdateSchema,
} from "@meshbot/types-agent";

/** 新建本地模型配置入参。 */
export class CreateModelConfigDto extends createZodDto(modelConfigSchema) {}

/** 更新本地模型配置入参（局部字段）。 */
export class UpdateModelConfigDto extends createZodDto(
  modelConfigUpdateSchema,
) {}

/** 启用/停用切换入参。 */
export class SetModelConfigEnabledDto extends createZodDto(
  modelConfigEnabledSchema,
) {}
