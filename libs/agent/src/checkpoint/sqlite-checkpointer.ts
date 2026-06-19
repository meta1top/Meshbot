import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import Database from "better-sqlite3";

/**
 * 创建 LangGraph SqliteSaver。
 *
 * `SqliteSaver.fromConnString` 直接 `new Database(path)`，不配任何 pragma，其
 * better-sqlite3 连接 `busy_timeout=0`——与 TypeORM DataSource（同一 agent.db）并发写时
 * 会立即抛 `SQLITE_BUSY: database is locked` 把进程打崩（putWrites 撞上 TypeORM COMMIT）。
 *
 * 这里自建连接，设与 DataSource（app.module 的 prepareDatabase）一致的：
 * - `journal_mode=WAL`：提升并发读写（文件级属性，幂等重设无害）
 * - `busy_timeout=5000`：阻塞写在 5s 内重试而非立即失败（**连接级**，每条连接都要各设）
 */
export function createSqliteCheckpointer(dbPath: string): SqliteSaver {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return new SqliteSaver(db);
}
