import { z } from "zod";

/**
 * server-agent 启动期环境变量 schema —— Phase 6 C3。
 *
 * 本地 Agent 形态：单进程 SQLite，无外部依赖。校验仅覆盖端口 / 数据目录。
 */
export const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  /** server-agent HTTP 端口，默认 3100 */
  MESHBOT_PORT: z.coerce.number().int().min(1).max(65535).default(3100),

  /**
   * meshbot 本地数据目录。默认 `~/.meshbot/`。
   * 容器内部署时通常注入 `/data` 配合 volume。
   */
  MESHBOT_HOME: z.string().optional(),

  /** Web Agent 静态资源目录覆盖；Docker / 远程测试场景才用 */
  MESHBOT_WEB_AGENT_DIR: z.string().optional(),

  /** JWT 签名密钥（本地登录用），默认开发兜底值 */
  MESHBOT_JWT_SECRET: z.string().min(8).optional(),
});

export type Env = z.infer<typeof EnvSchema>;
