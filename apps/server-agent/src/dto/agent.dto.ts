import { createZodDto } from "@meshbot/common";
import {
  AgentCreateSchema,
  AgentUpdateSchema,
  AgentViewSchema,
  McpRawSchema,
  PromptFileBodySchema,
  PromptFileMetaSchema,
  ToolPrefsSchema,
  ToolPrefsViewSchema,
} from "@meshbot/types-agent";

/** POST /api/agents 入参 DTO。 */
export class AgentCreateDto extends createZodDto(AgentCreateSchema) {}

/** PATCH /api/agents/:id 入参 DTO（全字段可选）。 */
export class AgentUpdateDto extends createZodDto(AgentUpdateSchema) {}

/** Agent 对外视图响应 DTO（Swagger 类型声明用）。 */
export class AgentViewDto extends createZodDto(AgentViewSchema) {}

/** GET/PUT /api/agents/:id/mcp 的 mcp.json 原始文本载体（请求体与响应共用）。 */
export class McpRawDto extends createZodDto(McpRawSchema) {}

/** GET /api/agents/:id/prompts 列表项 DTO。 */
export class PromptFileMetaDto extends createZodDto(PromptFileMetaSchema) {}

/** GET/PUT /api/agents/:id/prompts/:file 的正文载体（请求体与响应共用）。 */
export class PromptFileBodyDto extends createZodDto(PromptFileBodySchema) {}

/** GET /api/agents/:id/tools 响应 DTO：分组全量工具 + 禁用/豁免标记。 */
export class ToolPrefsViewDto extends createZodDto(ToolPrefsViewSchema) {}

/** PUT /api/agents/:id/tools 入参 DTO：待禁用工具名列表。 */
export class ToolPrefsDto extends createZodDto(ToolPrefsSchema) {}
