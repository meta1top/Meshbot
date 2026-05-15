/**
 * TypeORM CLI 用 DataSource —— 仅供 `pnpm migration:generate:main` /
 * `migration:run:main` / `migration:revert:main` / `migration:show:main` 使用。
 * runtime 走 `app.module.ts` 里的 `TypeOrmModule.forRootAsync`，不动这个文件。
 *
 * 入口 entities 用 glob 指向 libs/main 源码 + 编译产物，CLI 两种形态都吃。
 * 路径以 `process.cwd()`（repo root）为基准，避免 NodeNext ESM 下 __dirname 缺失。
 */
import "reflect-metadata";
import path from "node:path";
import { config } from "dotenv";
import { DataSource } from "typeorm";
import { SnakeNamingStrategy } from "typeorm-naming-strategies";

const REPO_ROOT = process.cwd();
const APP_ROOT = path.join(REPO_ROOT, "apps", "server-main");

config({ path: path.join(APP_ROOT, ".env.development") });
config({ path: path.join(APP_ROOT, ".env") });

export default new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: [
    path.join(REPO_ROOT, "libs", "main", "src", "**", "*.entity.{ts,js}"),
  ],
  migrations: [path.join(APP_ROOT, "src", "migrations", "*.{ts,js}")],
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false,
});
