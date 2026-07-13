"use client";

/**
 * `MarkdownContent` 原在本文件定义，Task 7 迁入 `@meshbot/web-common/session`
 * （组件零外部依赖，整体搬迁，未拆 props）。这里改为 re-export，
 * `@/components/session/markdown-content` 既有 import 路径不变。
 */
export { MarkdownContent } from "@meshbot/web-common/session";
