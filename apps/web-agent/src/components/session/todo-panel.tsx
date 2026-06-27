"use client";

import { ListTodo } from "lucide-react";
import { selectLatestTodos } from "@/lib/todo";
import type { TimelineMessage } from "./message-list";
import { TodoList } from "./todo-list";

/** 会话常驻待办面板：从消息历史派生「当前最新」清单；空则不渲染。 */
export function TodoPanel({ messages }: { messages: TimelineMessage[] }) {
  const todos = selectLatestTodos(messages);
  if (todos.length === 0) {
    return null;
  }
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="sticky top-0 z-10 mb-2 flex flex-col gap-1.5 rounded-[8px] border border-border bg-background/95 px-3 py-2 backdrop-blur">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ListTodo className="h-3.5 w-3.5" />
        待办（{done}/{todos.length} 完成）
      </div>
      <TodoList todos={todos} />
    </div>
  );
}
