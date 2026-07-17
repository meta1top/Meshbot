import {
  type ActiveModelConfig,
  CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
  type ModelConfigReadPort,
} from "@meshbot/lib-agent";
import type { ModelConfig } from "../entities/model-config.entity";
import type { ModelConfigService } from "./model-config.service";

/**
 * 把 `ModelConfig`（`ModelConfigService` 合并视图：本地 local 行 + 云端读时
 * 代理 cloud 行）映射为 `ModelResolver` 消费的 `ActiveModelConfig`。
 *
 * `isCloudModel` 用 apiKey 是否等于云网关占位符判定，**不用 `source` 字段**——
 * 与旧 reader（`readActiveModelConfig`/`readModelConfigById`）的判定口径保持
 * 字节一致，避免两处判定标准漂移。
 */
function toActiveModelConfig(cfg: ModelConfig): ActiveModelConfig {
  return {
    providerType: cfg.providerType,
    model: cfg.model,
    name: cfg.name,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    isCloudModel: cfg.apiKey === CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
  };
}

/**
 * MODEL_CONFIG_READ_PORT 工厂逻辑：委托 `ModelConfigService` 合并视图
 * （Critical C-1 修复——`ModelResolver` 不再直读 sqlite `model_configs` 表，
 * 云端模型 `source='cloud'`（读时代理、不落库）才能在运行时被正确解析）。
 *
 * 抽成具名函数便于单测（无需起 Nest 容器，同 `createAgentRenamePort` 范式）。
 * `resolveActive`/`resolveById` 都在账号上下文内被调
 * （`ModelResolver.resolveModel()`/`getTitleModel()` 内），`ModelConfigService`
 * 内部的 `ScopedRepository` 依赖 ALS 账号上下文，同步链上有效。
 */
export function createModelConfigReadPort(
  modelConfig: ModelConfigService,
): ModelConfigReadPort {
  return {
    async resolveActive() {
      const cfg = await modelConfig.findEnabled();
      return cfg ? toActiveModelConfig(cfg) : null;
    },
    async resolveById(id: string) {
      const cfg = await modelConfig.findByIdOrName(id);
      return cfg ? toActiveModelConfig(cfg) : null;
    },
  };
}
