import { z } from "zod";

/**
 * dispatch_subagent 工具入参。
 * - task：子任务完整指令（作为子 Agent 的初始 user 消息）。
 * - description：短标题（用于前端嵌套卡显示；缺省用 task 截断）。
 * - model：可选，ModelConfig id/名；缺省用当前启用模型（即继承父 run 模型）。
 * - background：默认 false=前台阻塞；true=后台运行，完成后自动播报回父会话。
 */
export const dispatchSubagentSchema = z.object({
  task: z.string().min(1),
  description: z.string().optional(),
  model: z
    .string()
    .optional()
    .describe(
      "Optional override for the sub-agent's model, by ModelConfig id or name. Defaults to the parent's active model.",
    ),
  background: z
    .boolean()
    .default(false)
    .describe(
      'If true, return immediately with {subSessionId,status:"running"} and announce completion back into this session later. If false (default), block until the sub-agent finishes and return its result.',
    ),
});

export type DispatchSubagentInput = z.infer<typeof dispatchSubagentSchema>;
