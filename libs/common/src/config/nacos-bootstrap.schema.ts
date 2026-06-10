import { z } from "zod";

/** Nacos 引导配置 schema：namespace / group / dataId 带默认，鉴权可选。 */
export const NacosBootstrapSchema = z
  .object({
    serverAddr: z.string().min(1),
    namespace: z.string().default("public"),
    group: z.string().default("DEFAULT_GROUP"),
    dataId: z.string().default("meshbot-server-main.yaml"),
    username: z.string().optional(),
    password: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (Boolean(val.username) !== Boolean(val.password)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [val.username ? "password" : "username"],
        message: "NACOS_USERNAME 与 NACOS_PASSWORD 必须成对设置",
      });
    }
  });

export type NacosBootstrap = z.infer<typeof NacosBootstrapSchema>;

const FIELD_TO_ENV: Record<string, string> = {
  serverAddr: "NACOS_SERVER_ADDR",
  namespace: "NACOS_NAMESPACE",
  group: "NACOS_GROUP",
  dataId: "NACOS_DATA_ID",
  username: "NACOS_USERNAME",
  password: "NACOS_PASSWORD",
};

/**
 * 从 env 读取 Nacos 引导配置。
 * - 未设 `NACOS_SERVER_ADDR` → 返回 `null`（调用方回退本地 YAML）。
 * - 设了但其它字段非法 → 抛错并指出字段。
 */
export function readNacosBootstrap(
  env: Record<string, string | undefined>,
): NacosBootstrap | null {
  if (!env.NACOS_SERVER_ADDR) return null;
  const parsed = NacosBootstrapSchema.safeParse({
    serverAddr: env.NACOS_SERVER_ADDR,
    namespace: env.NACOS_NAMESPACE,
    group: env.NACOS_GROUP,
    dataId: env.NACOS_DATA_ID,
    username: env.NACOS_USERNAME,
    password: env.NACOS_PASSWORD,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => {
        const field = String(i.path[0]);
        return `  - ${FIELD_TO_ENV[field] ?? `NACOS_${field}`}: ${i.message}`;
      })
      .join("\n");
    throw new Error(`[config-loader] Nacos 引导变量校验失败：\n${issues}`);
  }
  return parsed.data;
}
