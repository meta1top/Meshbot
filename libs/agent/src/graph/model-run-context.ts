import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";

interface ModelRunStore {
  /** per-run 模型覆盖：ModelConfig id；null=用当前启用配置。 */
  modelConfigId: string | null;
  /** 本 run 最近一次解析出的模型 meta（usage 标注用，run 间互不串）。 */
  meta: { providerType: string; model: string; modelName?: string } | null;
}

/**
 * run 级模型上下文（AsyncLocalStorage）：承载 per-run 模型覆盖 id 与本 run 已
 * 解析的 meta。RunnerService 在消费循环外层 run()（无论有无覆盖都建 store，
 * meta 才能按 run 隔离——共享实例字段在并行 run 用不同模型时会互相覆盖标错
 * llm_calls）。注意 async generator 的 next() 跑在调用方上下文：必须包裹
 * 「建流 + for-await」整段，包在 generator 创建处无效。
 */
@Injectable()
export class ModelRunContext {
  private readonly als = new AsyncLocalStorage<ModelRunStore>();

  /** 在 run 级模型上下文中执行 fn（总是新建 store）。 */
  run<T>(modelConfigId: string | null, fn: () => T): T {
    return this.als.run({ modelConfigId, meta: null }, fn);
  }

  /** 当前 run 的覆盖 id；无上下文或无覆盖返回 null。 */
  getOverrideId(): string | null {
    return this.als.getStore()?.modelConfigId ?? null;
  }

  /** 写入本 run 解析出的模型 meta。 */
  setMeta(meta: {
    providerType: string;
    model: string;
    modelName?: string;
  }): void {
    const store = this.als.getStore();
    if (store) store.meta = meta;
  }

  /** 本 run 的模型 meta；无上下文返回 null。 */
  getMeta(): {
    providerType: string;
    model: string;
    modelName?: string;
  } | null {
    return this.als.getStore()?.meta ?? null;
  }
}
