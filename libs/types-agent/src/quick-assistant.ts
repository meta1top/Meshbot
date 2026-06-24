import { z } from "zod";

/** 随手问默认名字（无设置时回退）。 */
export const QUICK_ASSISTANT_DEFAULT_NAME = "M";

/** 随手问名字长度上限。 */
export const QUICK_ASSISTANT_NAME_MAX = 20;

/** 改名输入（REST PATCH 体 + 改名 tool 参数共用）。 */
export const renameQuickAssistantSchema = z.object({
  name: z.string().trim().min(1).max(QUICK_ASSISTANT_NAME_MAX),
});
export type RenameQuickAssistantInput = z.infer<
  typeof renameQuickAssistantSchema
>;

/** 随手问名字读取响应。 */
export const quickAssistantNameSchema = z.object({
  name: z.string(),
});
export type QuickAssistantName = z.infer<typeof quickAssistantNameSchema>;
