import { z } from "zod";

/**
 * server-main 启动期环境变量 schema —— Phase 6 C3。
 *
 * `ConfigModule.forRoot({ validate: createEnvValidator(EnvSchema) })` 在启动
 * 期校验；缺失或不合法字段直接 exit 1 + 报错指出哪条 env。
 *
 * Tip：跑 `cp apps/server-main/.env.development.example .env.development` 拿到
 * 模板，然后填本机 secret。
 */
export const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  /** server-main HTTP 端口，默认 3200 */
  PORT: z.coerce.number().int().min(1).max(65535).default(3200),

  /** Postgres 连接串，必须以 postgresql:// 开头 */
  DATABASE_URL: z.string().url().startsWith("postgresql://"),

  /**
   * JWT 签名密钥，最少 16 字符；生产建议 32 字节随机串：
   * `openssl rand -base64 48`
   */
  JWT_SECRET: z
    .string()
    .min(16, "JWT_SECRET 至少 16 字符（生产建议 32 字节随机串）"),

  /** JWT 过期时间，格式如 `7d` / `12h` / `60m` / `3600s` */
  JWT_EXPIRES: z
    .string()
    .regex(/^\d+[smhd]$/, "JWT_EXPIRES 格式应如 7d / 12h / 60m / 3600s")
    .default("7d"),

  /**
   * Redis 连接串（可选）。未设置时 LockProvider / CacheProvider / Throttler 走
   * memory 兜底（仅单实例正确）。
   */
  REDIS_URL: z.string().url().startsWith("redis").optional(),

  /**
   * Snowflake 节点 ID（0-1023）。多实例必配，单实例 / 本地留空走 hostname hash。
   */
  MESHBOT_NODE_ID: z.coerce.number().int().min(0).max(1023).optional(),
});

export type Env = z.infer<typeof EnvSchema>;
