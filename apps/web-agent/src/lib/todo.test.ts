import { describe, expect, it } from "@jest/globals";
import { selectLatestTodos, todoStatusMeta } from "./todo";

const tc = (name: string, todos: unknown) => ({
  role: "assistant",
  toolCalls: [{ name, args: { todos } }],
});

describe("selectLatestTodos", () => {
  it("取最新一次 todo_write 的 todos", () => {
    const messages = [
      tc("todo_write", [{ content: "旧", status: "pending", activeForm: "x" }]),
      { role: "user" },
      tc("todo_write", [
        { content: "新", status: "completed", activeForm: "y" },
      ]),
    ];
    const todos = selectLatestTodos(messages as never);
    expect(todos).toHaveLength(1);
    expect(todos[0].content).toBe("新");
  });

  it("无 todo_write → 空数组", () => {
    expect(
      selectLatestTodos([
        { role: "assistant", toolCalls: [{ name: "date", args: {} }] },
        { role: "user" },
      ] as never),
    ).toEqual([]);
  });
});

describe("todoStatusMeta", () => {
  it("三状态各有 label", () => {
    expect(todoStatusMeta("pending").label).toBeTruthy();
    expect(todoStatusMeta("in_progress").label).toBeTruthy();
    expect(todoStatusMeta("completed").label).toBeTruthy();
  });
});
