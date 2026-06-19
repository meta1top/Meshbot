import { createZodDto } from "@meshbot/common";
import { SidebarResponseSchema } from "@meshbot/types-agent";

/** GET /api/sidebar 出参 DTO（Swagger 类型声明用）。 */
export class SidebarResponseDto extends createZodDto(SidebarResponseSchema) {}
