import { describe, expect, it } from "@jest/globals";
import { todoStatusMeta } from "./todo";

describe("todoStatusMeta", () => {
  it("三状态各有 label", () => {
    expect(todoStatusMeta("pending").label).toBeTruthy();
    expect(todoStatusMeta("in_progress").label).toBeTruthy();
    expect(todoStatusMeta("completed").label).toBeTruthy();
  });
});
