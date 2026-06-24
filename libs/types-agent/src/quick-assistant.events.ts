import { z } from "zod";

/** server-agent 本地事件：随手问被改名（agent 改名 tool 或 UI 触发），下行实时刷新 dock 标题。 */
export const QUICK_ASSISTANT_EVENTS = {
  renamed: "quick_assistant.renamed",
} as const;

export const QuickAssistantRenamedEventSchema = z.object({
  name: z.string(),
});

export type QuickAssistantRenamedEvent = z.infer<
  typeof QuickAssistantRenamedEventSchema
>;
