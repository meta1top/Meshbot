import type { ZodTypeAny, z } from "zod";

/**
 * 创建一个用于 NestJS `ConfigModule.forRoot({ validate })` 的环境变量校验函数。
 *
 * Phase 6 C2：启动期 fail-fast。`validate` 在 ConfigModule 初始化时调用，
 * 抛错则进程整体退出（NestJS 默认行为）。
 *
 * 用法：
 * ```ts
 * // apps/server-main/src/env.schema.ts
 * export const EnvSchema = z.object({
 *   DATABASE_URL: z.string().url().startsWith("postgresql://"),
 *   JWT_SECRET: z.string().min(16),
 *   // ...
 * });
 *
 * // apps/server-main/src/app.module.ts
 * ConfigModule.forRoot({
 *   isGlobal: true,
 *   envFilePath: [".env.development", ".env"],
 *   validate: createEnvValidator(EnvSchema),
 * })
 * ```
 *
 * 校验失败时抛 Error 含字段路径 + 原因，stderr 输出便于运维定位。
 *
 * **值回写**：Zod 的 `.default()` / `z.coerce` 会产出与原始 `process.env`
 * 不同的值（如 `NODE_ENV` 默认 "development"、`PORT` coerce 成 number）。
 * 仅返回 `parsed.data` 时这些转换只对走 `ConfigService` 的读取生效；
 * 项目中 `process.env.NODE_ENV` / Snowflake `MESHBOT_NODE_ID` 等存在直读
 * `process.env` 的路径，会拿到未经转换的原始值，使校验"形同虚设"。
 * 因此把校验/转换后的值字符串化写回 `process.env`，保证两条读取路径一致。
 */
export function createEnvValidator<T extends ZodTypeAny>(schema: T) {
  return (env: Record<string, unknown>): z.infer<T> => {
    const parsed = schema.safeParse(env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => {
          const path = i.path.length > 0 ? i.path.join(".") : "<root>";
          return `  - ${path}: ${i.message}`;
        })
        .join("\n");
      throw new Error(
        `[env-schema] 环境变量校验失败：\n${issues}\n请检查 .env.* 或部署环境变量是否齐全 / 合法。`,
      );
    }
    // 把 default / coerce 转换后的值回写 process.env，让直读 process.env
    // 的代码路径（NODE_ENV / MESHBOT_NODE_ID 等）与 ConfigService 取值一致。
    for (const [key, value] of Object.entries(
      parsed.data as Record<string, unknown>,
    )) {
      if (value === undefined || value === null) continue;
      process.env[key] = typeof value === "string" ? value : String(value);
    }
    return parsed.data;
  };
}
