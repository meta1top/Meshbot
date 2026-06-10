import path from "node:path";
import { config as loadDotenv } from "dotenv";
import type { ZodType, z } from "zod";
import { readNacosBootstrap } from "./nacos-bootstrap.schema";
import { loadNacosConfig } from "./nacos-source";
import { normalizeKeys } from "./normalize-keys";
import { loadYamlConfig } from "./yaml-source";

export interface LoadAppConfigOptions {
  cwd?: string;
  envFiles?: string[];
  yamlFiles?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * 引导式配置加载：必须在 `NestFactory.create(AppModule.forRoot(config))` 之前调用。
 * 1. 读 `.env`（写进 process.env，不覆盖已有）—— 提供 Nacos 引导变量与扁平 secret。
 * 2. `NACOS_SERVER_ADDR` 存在 → 从 Nacos 拉嵌套配置；否则读本地 YAML。
 * 3. 用传入的 zod schema 校验嵌套对象，返回强类型嵌套配置。
 */
export async function loadAppConfig<S extends ZodType>(
  schema: S,
  options: LoadAppConfigOptions = {},
): Promise<z.output<S>> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const envFiles = options.envFiles ?? [];
  const yamlFiles = options.yamlFiles ?? [];

  for (const file of envFiles) {
    loadDotenv({
      path: path.resolve(cwd, file),
      processEnv: env,
      override: false,
    });
  }

  const bootstrap = readNacosBootstrap(env);
  const source: "nacos" | "yaml" = bootstrap ? "nacos" : "yaml";
  const nested = bootstrap
    ? await loadNacosConfig(bootstrap)
    : loadYamlConfig(yamlFiles.map((f) => path.resolve(cwd, f)));

  const normalized = normalizeKeys(nested);

  const parsed = schema.safeParse(normalized);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `[config-loader] 配置校验失败（源=${source}）：\n${issues}\n` +
        "请检查 YAML / Nacos 配置内容或 .env 引导变量是否齐全 / 合法。",
    );
  }

  console.log(`[config-loader] 配置源=${source}，已加载并校验通过`);
  return parsed.data;
}
