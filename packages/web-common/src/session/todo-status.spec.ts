import { todoStatusMeta } from "./todo-status";

describe("todoStatusMeta", () => {
  it("三状态各有 label", () => {
    expect(todoStatusMeta("pending").label).toBeTruthy();
    expect(todoStatusMeta("in_progress").label).toBeTruthy();
    expect(todoStatusMeta("completed").label).toBeTruthy();
  });
});
