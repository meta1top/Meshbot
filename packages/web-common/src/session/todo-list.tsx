import { cn } from "@meshbot/design";
import type { TodoItem } from "@meshbot/types-agent";
import { Circle, CircleCheck, CircleDot } from "lucide-react";
import { todoStatusMeta } from "./todo-status";

/**
 * 渲染一份 todo 清单：状态图标 + 文案（进行中显示 activeForm）。
 *
 * 从 `apps/web-agent/src/components/session/todo-list.tsx` 迁入（Task 8）——
 * 零 jotai/next-intl 依赖，整体搬迁；原文件改为 re-export。
 */
export function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="flex flex-col gap-1">
      {todos.map((t) => {
        const meta = todoStatusMeta(t.status);
        const Icon =
          t.status === "completed"
            ? CircleCheck
            : t.status === "in_progress"
              ? CircleDot
              : Circle;
        return (
          <div key={t.content} className="flex items-start gap-2 text-sm">
            <Icon
              className={cn(
                "mt-0.5 h-3.5 w-3.5 shrink-0",
                t.status === "completed"
                  ? "text-green-600"
                  : t.status === "in_progress"
                    ? "text-primary"
                    : "text-muted-foreground/50",
              )}
            />
            <span className={meta.className}>
              {t.status === "in_progress" ? t.activeForm : t.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}
