import { vi } from "vitest";
import type { ToolContext } from "../tool.types";
import { MemoryDeleteTool } from "./memory-delete.tool";

function fakeCtx(): ToolContext {
  return {
    sessionId: "s1",
    messageId: "m1",
    toolCallId: "tc1",
    emitter: {} as never,
    signal: new AbortController().signal,
  };
}

function makeMemory() {
  return {
    writeCore: vi.fn(),
    readCore: vi.fn().mockReturnValue(""),
    add: vi.fn(),
    search: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
  };
}

describe("MemoryDeleteTool", () => {
  it("schema 接受 id 字段", () => {
    const tool = new MemoryDeleteTool(makeMemory() as never);
    expect(tool.schema.safeParse({ id: "12345" }).success).toBe(true);
  });

  it("schema 拒绝缺少 id", () => {
    const tool = new MemoryDeleteTool(makeMemory() as never);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  it("调用 memory.delete 并返回 'Deleted <id>.'", async () => {
    const mem = makeMemory();
    const tool = new MemoryDeleteTool(mem as never);

    const out = await tool.execute({ id: "999888777" }, fakeCtx());
    expect(mem.delete).toHaveBeenCalledWith("999888777");
    expect(out).toBe("Deleted 999888777.");
  });

  it("不存在的 id 时 delete 仍被调用（幂等由 service 保证）", async () => {
    const mem = makeMemory();
    const tool = new MemoryDeleteTool(mem as never);

    const out = await tool.execute({ id: "000" }, fakeCtx());
    expect(mem.delete).toHaveBeenCalledWith("000");
    expect(out).toBe("Deleted 000.");
  });
});
