import { z } from "zod";

/**
 * mcp.json 配置 schema：
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
 *       "env": { "FOO": "bar" }
 *     },
 *     "remote": {
 *       "url": "https://example.com/mcp",
 *       "transport": "sse",
 *       "headers": { "Authorization": "Bearer xxx" }
 *     }
 *   }
 * }
 * ```
 *
 * 兼容 Claude Desktop / Claude Code 的字段名：`command` 字段在 → stdio；
 * `url` 字段在 → http/sse（transport 字段决定，缺省 `streamable_http`）。
 */

const StdioServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const HttpServerSchema = z.object({
  url: z.string().url(),
  transport: z.enum(["sse", "streamable_http"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

/** 单个 server 配置：stdio（command）或 http/sse（url）二选一。 */
export const McpServerConfigSchema = z.union([
  StdioServerSchema,
  HttpServerSchema,
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** 整个 mcp.json 文件结构。 */
export const McpConfigSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;

/** 判别 stdio / http server，给 McpService 路由用。 */
export function isStdioServer(
  cfg: McpServerConfig,
): cfg is z.infer<typeof StdioServerSchema> {
  return "command" in cfg;
}
