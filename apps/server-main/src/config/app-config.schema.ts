import { z } from "zod";

/** 数据库配置 —— 直接映射 TypeORM postgres DataSourceOptions。 */
export const DatabaseConfigSchema = z
  .object({
    type: z.literal("postgres").default("postgres"),
    host: z.string().default("localhost"),
    port: z.coerce.number().int().min(1).max(65535).default(5432),
    username: z.string(),
    password: z.string(),
    database: z.string(),
    synchronize: z.boolean().default(false),
    autoLoadEntities: z.boolean().default(true),
    logging: z
      .union([
        z.boolean(),
        z.array(
          z.enum([
            "query",
            "error",
            "warn",
            "info",
            "log",
            "migration",
            "schema",
          ]),
        ),
      ])
      .optional(),
  })
  .passthrough();

/** JWT 签名配置。 */
export const JwtConfigSchema = z.object({
  secret: z
    .string()
    .min(16, "jwt.secret 至少 16 字符（生产建议 32 字节随机串）"),
  expires: z
    .string()
    .regex(/^\d+[smhd]$/, "jwt.expires 形如 7d / 12h / 60m / 3600s")
    .default("7d"),
});

/** Redis 配置（可选）。未配置 → 锁/缓存/限流走 memory 兜底。 */
export const RedisConfigSchema = z.object({
  host: z.string(),
  port: z.coerce.number().int().min(1).max(65535).default(6379),
  db: z.coerce.number().int().min(0).max(15).default(0),
  password: z.string().optional(),
});

/** 邮件发送配置（可选）—— 阿里云 DirectMail。未配置 → LogEmailSender 兜底。 */
export const EmailConfigSchema = z.object({
  endpoint: z.string().default("dm.aliyuncs.com"),
  accountName: z.string(),
  accessKeyId: z.string(),
  accessKeySecret: z.string(),
  from: z.string().optional(),
});

/** 邀请配置。过期天数。 */
export const InvitationConfigSchema = z.object({
  expiresDays: z.coerce.number().int().min(1).max(30).default(7),
});

/** Minio 对象存储配置。缺省值指向本地 minio（dev 模式下无需显式配置即可启动）。 */
export const MinioConfigSchema = z.object({
  endPoint: z.string().default("localhost"),
  port: z.coerce.number().int().min(1).max(65535).default(9000),
  useSSL: z.coerce.boolean().default(false),
  accessKey: z.string().default("minioadmin"),
  secretKey: z.string().default("minioadmin"),
  bucket: z.string().default("meshbot-skills"),
});

/** 资产存储配置切片（对象存储）。 */
export const AssetsConfigSchema = z.object({
  minio: MinioConfigSchema.default({}),
});

export const AppConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3200),
  database: DatabaseConfigSchema,
  jwt: JwtConfigSchema,
  redis: RedisConfigSchema.optional(),
  email: EmailConfigSchema.optional(),
  invitation: InvitationConfigSchema.default({ expiresDays: 7 }),
  assets: AssetsConfigSchema.default({}),
  /** web-main 前端基础 URL，用于拼分享链接。默认指向本地开发端口。 */
  webMainBase: z.string().url().default("http://localhost:3002"),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type JwtConfig = z.infer<typeof JwtConfigSchema>;
export type RedisConfig = z.infer<typeof RedisConfigSchema>;
export type EmailConfig = z.infer<typeof EmailConfigSchema>;
export type InvitationConfig = z.infer<typeof InvitationConfigSchema>;
export type MinioConfig = z.infer<typeof MinioConfigSchema>;
export type AssetsConfig = z.infer<typeof AssetsConfigSchema>;

/** 全局 DI token —— 持有强类型嵌套 AppConfig。 */
export const APP_CONFIG = Symbol("APP_CONFIG");
