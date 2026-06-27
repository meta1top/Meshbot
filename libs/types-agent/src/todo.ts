import { z } from "zod";

/** 单条待办：描述 + 状态 + 进行中标签。 */
export const todoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().min(1),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

/** todo_write 入参：覆盖式整表（非空）。 */
export const todoWriteSchema = z.object({
  todos: z.array(todoItemSchema).min(1),
});
export type TodoWriteInput = z.infer<typeof todoWriteSchema>;
