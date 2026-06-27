import { describe, expect, it } from "vitest";
import { TodoWriteTool } from "../../src/tools/builtins/todo-write.tool";

describe("todo_write tool", () => {
  it("返回含进度（完成数/总数）与各项状态的摘要", async () => {
    const tool = new TodoWriteTool();
    expect(tool.name).toBe("todo_write");
    const out = await tool.execute(
      {
        todos: [
          { content: "A", status: "completed", activeForm: "正在 A" },
          { content: "B", status: "in_progress", activeForm: "正在 B" },
          { content: "C", status: "pending", activeForm: "正在 C" },
        ],
      },
      {} as never,
    );
    expect(out).toContain("1/3");
    expect(out).toContain("正在 B");
    expect(out).toContain("C");
  });
});
