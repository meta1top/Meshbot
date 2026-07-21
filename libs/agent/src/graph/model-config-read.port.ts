import type { ActiveModelConfig } from "../config/model-config.reader";

/**
 * MODEL_CONFIG_READ_PORT —— libs/agent → server-agent 解耦端口（模型配置读）。
 *
 * ModelResolver 解析当前账号 chat model（`resolveModel()`/`getTitleModel()`）时，
 * 通过此端口取模型凭证。server-agent 侧绑定实现委托 `ModelConfigService`
 * 的合并视图（本地 `model_configs` 表 local 行 + 云端组织模型读时代理行），
 * 而非直读 sqlite——这样云端模型（`source='cloud'`，代理内存构造、绝不落库）
 * 才能在运行时被正确解析出来（Critical C-1：旧实现绕过合并视图直读 sqlite，
 * 云端模型行永不在 sqlite，运行时必然解析不出）。
 *
 * paramless resolveActive()：靠 AccountContextService（ALS）取当前账号，同
 * CLOUD_TOKEN_PORT 的范式——resolve 发生在 run 的账号上下文同步链上。
 */
export const MODEL_CONFIG_READ_PORT = Symbol("MODEL_CONFIG_READ_PORT");

/** 模型配置读端口。 */
export interface ModelConfigReadPort {
  /** 取当前账号第一条已启用的模型配置（本地/云端合并视图）；无则返回 null。 */
  resolveActive(): Promise<ActiveModelConfig | null>;
  /** 按 id（会话覆盖模型）取当前账号的模型配置（不过滤 enabled）；查不到返回 null。 */
  resolveById(id: string): Promise<ActiveModelConfig | null>;
}
