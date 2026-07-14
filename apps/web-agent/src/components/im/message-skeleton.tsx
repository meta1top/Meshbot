/**
 * `MessageSkeleton` 原在本文件定义，Task 7 迁入
 * `@meshbot/web-common/session`（组件零外部依赖，整体搬迁）。这里改为
 * re-export，`@/components/im/message-skeleton` 既有 import 路径不变。
 */
export { MessageSkeleton } from "@meshbot/web-common/session";
