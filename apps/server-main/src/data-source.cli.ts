/**
 * TypeORM CLI 用 DataSource —— 仅供 `pnpm migration:main <cmd>` 使用。
 * runtime 走 `app.module.ts` 里的 `TypeOrmModule.forRootAsync`，不动这个文件。
 *
 * 入口 entities 用 glob 指向 libs/main 源码 + 编译产物，CLI 两种形态都吃。
 * 路径以本文件所在目录为基准（typeorm-ts-node-commonjs 是 CJS，__dirname 可用），
 * 与 cwd 解耦，从任何目录运行都能正确解析。
 */
import "reflect-metadata";
import path from "node:path";
import { config } from "dotenv";
import { DataSource } from "typeorm";
import { SnakeNamingStrategy } from "typeorm-naming-strategies";

const SRC_DIR = __dirname;
const APP_ROOT = path.join(SRC_DIR, "..");
const REPO_ROOT = path.join(APP_ROOT, "..", "..");

config({ path: path.join(APP_ROOT, ".env.development") });
config({ path: path.join(APP_ROOT, ".env") });

export default new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: [
    path.join(REPO_ROOT, "libs", "main", "src", "**", "*.entity.{ts,js}"),
  ],
  migrations: [path.join(SRC_DIR, "migrations", "*.{ts,js}")],
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false,
});
