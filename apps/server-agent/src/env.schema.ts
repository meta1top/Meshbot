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

  /**
   * LangGraph ReAct 递归上限（一次 supervisor↔tools 往返算 2 个 super-step）。
   * 不设默认 100；长会话 + 多轮 tool 调用建议 100~200。
   */
  MESHBOT_GRAPH_RECURSION_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(100),

  /**
   * LangSmith 可观测性 —— 由 `@langchain/core` 内部 SDK 直读 process.env 自动启用，
   * 这里仅做"显式声明 + Zod 校验"，无需任何业务代码改动。
   *
   * 在 .env 中设置以下变量后，supervisor / tools 节点的 LLM 调用与图执行
   * 会被自动上报到 LangSmith：
   *   LANGSMITH_TRACING=true
   *   LANGSMITH_API_KEY=ls__xxx
   *   LANGSMITH_PROJECT=meshbot-dev          # 可选，缺省 "default"
   *   LANGSMITH_ENDPOINT=https://api.smith.langchain.com  # 可选，自托管才需要
   */
  LANGSMITH_TRACING: z
    .union([z.literal("true"), z.literal("false")])
    .optional(),
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;
