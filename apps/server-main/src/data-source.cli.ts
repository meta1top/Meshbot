/**
 * TypeORM CLI 用 DataSource —— 仅供 `pnpm migration <cmd>` 使用。
 * 与 runtime 同源：读 conf/application.yml（+ application.local.yml 覆盖），
 * 不读 Nacos（迁移生成是本地开发动作）。
 *
 * 入口 entities 用 glob 指向 libs/main 源码 + 编译产物，CLI 两种形态都吃。
 * 路径以本文件所在目录为基准（typeorm-ts-node-commonjs 是 CJS，__dirname 可用），
 * 与 cwd 解耦，从任何目录运行都能正确解析。
 */
import "reflect-metadata";
import path from "node:path";
import { loadYamlConfig, normalizeKeys } from "@meshbot/common";
import { DataSource, type DataSourceOptions } from "typeorm";
import { SnakeNamingStrategy } from "typeorm-naming-strategies";
import { AppConfigSchema } from "./config/app-config.schema";

const SRC_DIR = __dirname;
const APP_ROOT = path.join(SRC_DIR, "..");
const REPO_ROOT = path.join(APP_ROOT, "..", "..");

const nested = loadYamlConfig([
  path.join(APP_ROOT, "conf", "application.yml"),
  path.join(APP_ROOT, "conf", "application.local.yml"),
]);
const config = AppConfigSchema.parse(normalizeKeys(nested));

export default new DataSource({
  ...config.database,
  entities: [
    path.join(REPO_ROOT, "libs", "main", "src", "**", "*.entity.{ts,js}"),
  ],
  migrations: [path.join(SRC_DIR, "migrations", "*.{ts,js}")],
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false,
} as DataSourceOptions);
