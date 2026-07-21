import { createZodDto } from "@meshbot/common";
import {
  AgentCreateSchema,
  AgentUpdateSchema,
  AgentViewSchema,
  McpRawSchema,
} from "@meshbot/types-agent";

/** POST /api/agents 入参 DTO。 */
export class AgentCreateDto extends createZodDto(AgentCreateSchema) {}

/** PATCH /api/agents/:id 入参 DTO（全字段可选）。 */
export class AgentUpdateDto extends createZodDto(AgentUpdateSchema) {}

/** Agent 对外视图响应 DTO（Swagger 类型声明用）。 */
export class AgentViewDto extends createZodDto(AgentViewSchema) {}

/** GET/PUT /api/agents/:id/mcp 的 mcp.json 原始文本载体（请求体与响应共用）。 */
export class McpRawDto extends createZodDto(McpRawSchema) {}
