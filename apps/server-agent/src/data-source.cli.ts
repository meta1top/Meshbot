/**
 * TypeORM CLI 用 DataSource —— 仅供 `pnpm migration:{generate,run,revert,show}:agent`
 * 使用。runtime 走 `app.module.ts` 里的 `TypeOrmModule.forRoot`。
 *
 * 路径以 `process.cwd()`（repo root）为基准，避免 NodeNext ESM 下 __dirname 缺失。
 * SQLite 文件位置：`~/.meshbot/agent.db`（与 runtime 一致）。
 */
import "reflect-metadata";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DataSource } from "typeorm";

const REPO_ROOT = process.cwd();
const APP_ROOT = path.join(REPO_ROOT, "apps", "server-agent");
const MESHBOT_DIR =
  process.env.MESHBOT_HOME ?? path.join(homedir(), ".meshbot");
mkdirSync(MESHBOT_DIR, { recursive: true });

export default new DataSource({
  type: "better-sqlite3",
  database: path.join(MESHBOT_DIR, "agent.db"),
  entities: [path.join(APP_ROOT, "src", "entities", "*.entity.{ts,js}")],
  migrations: [path.join(APP_ROOT, "src", "migrations", "*.{ts,js}")],
  synchronize: false,
});
