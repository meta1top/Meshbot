import Database from "better-sqlite3";

/** 启用的模型凭证。来自 server-agent 的 model_configs 表。 */
export interface ActiveModelConfig {
  providerType: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

/**
 * 只读 agent.db 的 model_configs 表，返回首个 enabled 的模型凭证。
 *
 * agent 进程本就持有 agent.db 路径（checkpointer 用）；这里复用同一文件做
 * 单表只读 SELECT，不引入 TypeORM Entity，把对 server-agent 表 schema 的
 * 耦合面控制在「列名」这一层。无启用配置返回 null。
 */
export function readActiveModelConfig(
  dbPath: string,
): ActiveModelConfig | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT provider_type, model, api_key, base_url
         FROM model_configs WHERE enabled = 1
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as
      | {
          provider_type: string;
          model: string;
          api_key: string;
          base_url: string;
        }
      | undefined;
    if (!row) return null;
    return {
      providerType: row.provider_type,
      model: row.model,
      apiKey: row.api_key,
      baseUrl: row.base_url,
    };
  } finally {
    db.close();
  }
}
