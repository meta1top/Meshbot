/**
 * `ChatInput` 原在本文件定义，Task 1 迁入 `@meshbot/web-common/session`
 * （`useTranslations` 改 `labels` props）。这里改为 re-export，
 * `@/components/common/chat-input` 既有 import 路径不变。
 */
export {
  ChatInput,
  type ChatInputHandle,
  type ChatInputLabels,
  type ChatInputProps,
} from "@meshbot/web-common/session";
