import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export function createSqliteCheckpointer(dbPath: string): SqliteSaver {
  return SqliteSaver.fromConnString(dbPath);
}
