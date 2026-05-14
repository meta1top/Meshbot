// 兼容性 re-export：PROVIDERS / ProviderDef / ModelConfigInput / modelConfigSchema
// 已迁到 @meshbot/types-agent（消除后端 → 前端 package 的反向依赖）。
// 前端代码仍可继续从 @meshbot/web-common 引用这些符号。
export {
  type ModelConfigInput,
  modelConfigSchema,
  PROVIDERS,
  type ProviderDef,
} from "@meshbot/types-agent";
