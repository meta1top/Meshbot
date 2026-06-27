import type { TodoItem } from "@meshbot/types-agent";

type ToolCallLike = { name: string; args?: unknown };
type MessageLike = { role: string; toolCalls?: ToolCallLike[] };

/** 从消息历史取最新一次 todo_write 的 todos；无则空数组。 */
export function selectLatestTodos(messages: MessageLike[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tcs = messages[i].toolCalls;
    if (!tcs) {
      continue;
    }
    for (let j = tcs.length - 1; j >= 0; j--) {
      if (tcs[j].name !== "todo_write") {
        continue;
      }
      const args = tcs[j].args as { todos?: TodoItem[] } | undefined;
      if (args?.todos) {
        return args.todos;
      }
    }
  }
  return [];
}

/** 状态 → 展示元信息（label + 文案 className）。 */
export function todoStatusMeta(status: TodoItem["status"]): {
  label: string;
  className: string;
} {
  switch (status) {
    case "completed":
      return {
        label: "已完成",
        className: "text-muted-foreground line-through",
      };
    case "in_progress":
      return { label: "进行中", className: "text-foreground font-medium" };
    default:
      return { label: "待办", className: "text-muted-foreground" };
  }
}
