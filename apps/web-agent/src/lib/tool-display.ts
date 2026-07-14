/**
 * `toolDisplayName`/`sanitizeMeshbotPaths` 原在本文件定义，Task 8 迁入
 * `@meshbot/web-common/session`（零依赖纯函数，tool-call-block 组件迁移时
 * 随迁）。这里改为 re-export，`@/lib/tool-display` 既有 import 路径不变。
 */
export {
  sanitizeMeshbotPaths,
  toolDisplayName,
} from "@meshbot/web-common/session";
