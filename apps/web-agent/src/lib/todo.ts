import type { TodoItem } from "@meshbot/types-agent";

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
