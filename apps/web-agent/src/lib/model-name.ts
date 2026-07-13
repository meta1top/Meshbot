/**
 * `resolveModelName` 原在本文件定义，Task 7 迁入 `@meshbot/web-common/session`
 * （零依赖纯函数，assistant-message-actions 组件迁移时随迁）。这里改为
 * re-export，`@/lib/model-name` 既有 import 路径不变。
 */
export { resolveModelName } from "@meshbot/web-common/session";
