/**
 * TypeORM CLI 用 DataSource —— 仅供 `pnpm migration:agent <cmd>` 使用。
 * runtime 走 `app.module.ts` 里的 `TypeOrmModule.forRoot`。
 *
 * 路径以本文件所在目录为基准（typeorm-ts-node-commonjs 是 CJS，__dirname 可用），
 * 与 cwd 解耦，从任何目录运行都能正确解析。
 * SQLite 文件位置：`~/.meshbot/main.db`（与 runtime 一致；LangGraph checkpoint
 * 另拆到各账号 `accounts/<id>/agent.db`，不归本 DataSource 管）。
 */
import "reflect-metadata";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DataSource } from "typeorm";

const SRC_DIR = __dirname;
const MESHBOT_DIR =
  process.env.MESHBOT_HOME ?? path.join(homedir(), ".meshbot");
mkdirSync(MESHBOT_DIR, { recursive: true });

export default new DataSource({
  type: "better-sqlite3",
  database: path.join(MESHBOT_DIR, "main.db"),
  entities: [path.join(SRC_DIR, "entities", "*.entity.{ts,js}")],
  migrations: [path.join(SRC_DIR, "migrations", "*.{ts,js}")],
  synchronize: false,
});
