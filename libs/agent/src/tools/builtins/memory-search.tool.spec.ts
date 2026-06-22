import { vi } from "vitest";
import type { MemoryEntry } from "../../memory/memory.types";
import type { ToolContext } from "../tool.types";
import { MemorySearchTool } from "./memory-search.tool";

function fakeCtx(): ToolContext {
  return {
    sessionId: "s1",
    messageId: "m1",
    toolCallId: "tc1",
    emitter: {} as never,
    signal: new AbortController().signal,
  };
}

function fakeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "111",
    title: "Note",
    tags: [],
    createdAt: "2026-06-23T00:00:00.000Z",
    content: "some content",
    ...overrides,
  };
}

function makeMemory(entries: MemoryEntry[] = []) {
  return {
    writeCore: vi.fn(),
    readCore: vi.fn().mockReturnValue(""),
    add: vi.fn(),
    search: vi.fn().mockReturnValue(entries),
    delete: vi.fn(),
  };
}

describe("MemorySearchTool", () => {
  it("schema 接受空 args（query/limit 均选填）", () => {
    const tool = new MemorySearchTool(makeMemory() as never);
    expect(tool.schema.safeParse({}).success).toBe(true);
    expect(tool.schema.safeParse({ query: "foo", limit: 5 }).success).toBe(
      true,
    );
  });

  it("schema 拒绝 limit 为小数", () => {
    const tool = new MemorySearchTool(makeMemory() as never);
    expect(tool.schema.safeParse({ limit: 1.5 }).success).toBe(false);
  });

  it("无参调用时传 undefined 给 memory.search，返回 JSON 数组", async () => {
    const entries = [fakeEntry()];
    const mem = makeMemory(entries);
    const tool = new MemorySearchTool(mem as never);

    const out = await tool.execute({}, fakeCtx());
    expect(mem.search).toHaveBeenCalledWith(undefined, undefined);
    expect(JSON.parse(out)).toEqual(entries);
  });

  it("透传 query/limit 给 memory.search", async () => {
    const mem = makeMemory([]);
    const tool = new MemorySearchTool(mem as never);

    await tool.execute({ query: "meeting", limit: 5 }, fakeCtx());
    expect(mem.search).toHaveBeenCalledWith("meeting", 5);
  });

  it("空结果返回空 JSON 数组 '[]'", async () => {
    const mem = makeMemory([]);
    const tool = new MemorySearchTool(mem as never);

    const out = await tool.execute({ query: "nothing" }, fakeCtx());
    expect(JSON.parse(out)).toEqual([]);
  });
});
