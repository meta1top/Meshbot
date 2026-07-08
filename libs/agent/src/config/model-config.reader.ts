import Database from "better-sqlite3";

/**
 * 云端网关代理 apiKey 占位符——真实厂商 key 只在云端持有，本地 agent.db
 * 的 `source='cloud'` 行 `api_key` 列固定写这个值（见 server-agent 的
 * `ModelConfigSyncService`）；真实 device token 在请求时由
 * `llm.factory.ts` 的 `buildCloudFetch` 动态注入，不落地本地库。
 * 定义在 libs/agent（而非 server-agent）以便 write（同步服务）与
 * read（这里 + createChatModel 云模型判定）两侧共用同一常量，避免漂移。
 */
export const CLOUD_GATEWAY_API_KEY_PLACEHOLDER = "__cloud__";

/** 启用的模型凭证。来自 server-agent 的 model_configs 表。 */
export interface ActiveModelConfig {
  providerType: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  /**
   * 是否为经云端网关代理的模型（`api_key` 列为占位符）。
   * true 时 createChatModel 需要动态注入 device token，缓存 key 也不能用
   * `apiKey` 字段本身（虽然它本就只是占位符，非真实 token）。
   */
  isCloudModel: boolean;
}

/**
 * 只读 agent.db 的 model_configs 表，返回**指定账号**首个 enabled 的模型凭证。
 *
 * agent 进程本就持有 agent.db 路径（checkpointer 用）；这里复用同一文件做
 * 单表只读 SELECT，不引入 TypeORM Entity，把对 server-agent 表 schema 的
 * 耦合面控制在「列名」这一层。
 *
 * v3 账号隔离：必须按 cloud_user_id 过滤，否则多账号共享一个 agent.db 时会
 * 串号借用他账号凭证（取全表首行）。该账号无启用配置返回 null（调用方据此报
 * “请先配置模型”，绝不回退到其他账号）。
 */
export function readActiveModelConfig(
  dbPath: string,
  cloudUserId: string,
): ActiveModelConfig | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT provider_type, model, api_key, base_url
         FROM model_configs WHERE cloud_user_id = ? AND enabled = 1
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(cloudUserId) as
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
      isCloudModel: row.api_key === CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
    };
  } finally {
    db.close();
  }
}

/**
 * 按 id 读指定账号的模型凭证（per-run 覆盖用；**不过滤 enabled**——覆盖本意
 * 就是用非默认模型）。查不到返回 null。
 */
export function readModelConfigById(
  dbPath: string,
  cloudUserId: string,
  id: string,
): ActiveModelConfig | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT provider_type, model, api_key, base_url
         FROM model_configs WHERE cloud_user_id = ? AND id = ? LIMIT 1`,
      )
      .get(cloudUserId, id) as
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
      isCloudModel: row.api_key === CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
    };
  } finally {
    db.close();
  }
}
