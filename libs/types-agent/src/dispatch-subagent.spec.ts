import { dispatchSubagentSchema } from "./dispatch-subagent";

describe("dispatchSubagentSchema", () => {
  it("最简：仅 task 通过", () => {
    const r = dispatchSubagentSchema.parse({ task: "查一下 X" });
    expect(r.task).toBe("查一下 X");
    expect(r.background).toBe(false);
  });

  it("含可选字段通过", () => {
    const r = dispatchSubagentSchema.parse({
      task: "t",
      description: "d",
      model: "m1",
      background: true,
    });
    expect(r).toEqual({
      task: "t",
      description: "d",
      model: "m1",
      background: true,
    });
  });

  it("缺 task 报错", () => {
    expect(() => dispatchSubagentSchema.parse({})).toThrow();
  });

  it("task 空串报错", () => {
    expect(() => dispatchSubagentSchema.parse({ task: "" })).toThrow();
  });
});
