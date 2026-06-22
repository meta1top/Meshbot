import { vi } from "vitest";
import type { MemoryEntry } from "../../memory/memory.types";
import type { ToolContext } from "../tool.types";
import { MemoryCoreWriteTool } from "./memory-core-write.tool";

function fakeCtx(): ToolContext {
  return {
    sessionId: "s1",
    messageId: "m1",
    toolCallId: "tc1",
    emitter: {} as never,
    signal: new AbortController().signal,
  };
}

function makeMemory(overrides: {
  writeCore?: (content: string) => void;
  readCore?: () => string;
  add?: (input: {
    content: string;
    title?: string;
    tags?: string[];
  }) => MemoryEntry;
  search?: (query?: string, limit?: number) => MemoryEntry[];
  delete?: (id: string) => void;
}) {
  return {
    writeCore: vi.fn(),
    readCore: vi.fn().mockReturnValue(""),
    add: vi.fn(),
    search: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
    ...overrides,
  };
}

describe("MemoryCoreWriteTool", () => {
  it("schema 接受 content 字段", () => {
    const tool = new MemoryCoreWriteTool(makeMemory({}) as never);
    const parsed = tool.schema.safeParse({ content: "hello" });
    expect(parsed.success).toBe(true);
  });

  it("schema 拒绝缺少 content", () => {
    const tool = new MemoryCoreWriteTool(makeMemory({}) as never);
    const parsed = tool.schema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("调用 memory.writeCore 并返回确认串", async () => {
    const mem = makeMemory({});
    const tool = new MemoryCoreWriteTool(mem as never);
    const out = await tool.execute({ content: "I like TypeScript" }, fakeCtx());
    expect(mem.writeCore).toHaveBeenCalledWith("I like TypeScript");
    expect(out).toBe("Core memory updated.");
  });

  it("writeCore 抛错时返回 'Failed: <msg>' 而不是抛出", async () => {
    const mem = makeMemory({
      writeCore: vi.fn().mockImplementation(() => {
        throw new Error("超限：3000 字节 > 2048 字节上限");
      }),
    });
    const tool = new MemoryCoreWriteTool(mem as never);
    const out = await tool.execute({ content: "x".repeat(3000) }, fakeCtx());
    expect(out).toMatch(/^Failed: /);
    expect(out).toContain("超限");
  });
});
