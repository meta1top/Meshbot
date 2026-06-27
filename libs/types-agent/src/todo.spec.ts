import { describe, expect, it } from "@jest/globals";
import { todoWriteSchema } from "./todo";

describe("todoWriteSchema", () => {
  it("接受合法 todos（三字段 + 合法 status）", () => {
    const parsed = todoWriteSchema.parse({
      todos: [
        {
          content: "修复登录 bug",
          status: "in_progress",
          activeForm: "正在修复登录 bug",
        },
        { content: "写测试", status: "pending", activeForm: "正在写测试" },
      ],
    });
    expect(parsed.todos).toHaveLength(2);
    expect(parsed.todos[0].status).toBe("in_progress");
  });

  it("todos 不能为空数组", () => {
    expect(() => todoWriteSchema.parse({ todos: [] })).toThrow();
  });

  it("status 限三枚举", () => {
    expect(() =>
      todoWriteSchema.parse({
        todos: [{ content: "x", status: "doing", activeForm: "y" }],
      }),
    ).toThrow();
  });

  it("content / activeForm 必填非空", () => {
    expect(() =>
      todoWriteSchema.parse({
        todos: [{ content: "", status: "pending", activeForm: "y" }],
      }),
    ).toThrow();
    expect(() =>
      todoWriteSchema.parse({
        todos: [{ content: "x", status: "pending", activeForm: "" }],
      }),
    ).toThrow();
    expect(() =>
      todoWriteSchema.parse({ todos: [{ content: "x", status: "pending" }] }),
    ).toThrow();
  });
});
