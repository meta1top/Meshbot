/**
 * MODEL_SPECS 已迁移至 @meshbot/types（跨域共享：libs/main 的云端入库解析
 * 也要用，而 main 域不依赖 types-agent）。本文件保留 re-export 兼容旧 import。
 */
export {
  FALLBACK_CONTEXT_WINDOW,
  getModelSpec,
  MODEL_SPECS,
  type ModelSpec,
  resolveContextWindow,
} from "@meshbot/types";
