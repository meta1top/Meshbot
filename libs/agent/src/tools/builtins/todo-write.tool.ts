import { type TodoWriteInput, todoWriteSchema } from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class TodoWriteTool implements MeshbotTool<TodoWriteInput, string> {
  readonly name = "todo_write";
  readonly description =
    "Plan and track a multi-step task as a todo list. Pass the COMPLETE list every " +
    "call (it overwrites). Mark a task in_progress right before you start it and " +
    "completed as soon as it's done; keep at most one in_progress. Skip this for " +
    "trivial single-step tasks. Each item: content (imperative), status, activeForm " +
    "(present-tense label shown while in progress).";
  readonly schema = todoWriteSchema;

  /** 覆盖式写待办清单；返回当前进度摘要（回灌 agent 上下文）。 */
  async execute(args: TodoWriteInput, _ctx: ToolContext): Promise<string> {
    const done = args.todos.filter((t) => t.status === "completed").length;
    const lines = args.todos.map((t) => {
      const mark =
        t.status === "completed"
          ? "[x]"
          : t.status === "in_progress"
            ? "[~]"
            : "[ ]";
      const text = t.status === "in_progress" ? t.activeForm : t.content;
      return `${mark} ${text}`;
    });
    return `待办已更新（${done}/${args.todos.length} 完成）：\n${lines.join("\n")}`;
  }
}
