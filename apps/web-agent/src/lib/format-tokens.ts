/**
 * `formatTokens` 原在本文件定义，Task 7 迁入 `@meshbot/web-common/session`
 * （零依赖纯函数，assistant-message-actions 组件迁移时随迁）。这里改为
 * re-export，`@/lib/format-tokens` 既有 import 路径不变。
 */
export { formatTokens } from "@meshbot/web-common/session";
