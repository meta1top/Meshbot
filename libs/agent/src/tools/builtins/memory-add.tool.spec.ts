import { vi } from "vitest";
import type { MemoryEntry } from "../../memory/memory.types";
import type { ToolContext } from "../tool.types";
import { MemoryAddTool } from "./memory-add.tool";

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
    id: "123456789",
    title: "Test",
    tags: ["test"],
    createdAt: "2026-06-23T00:00:00.000Z",
    content: "some content",
    ...overrides,
  };
}

function makeMemory(entry: MemoryEntry) {
  return {
    writeCore: vi.fn(),
    readCore: vi.fn().mockReturnValue(""),
    add: vi.fn().mockReturnValue(entry),
    search: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
  };
}

describe("MemoryAddTool", () => {
  it("schema 接受 content（必填）+ title/tags（选填）", () => {
    const tool = new MemoryAddTool(makeMemory(fakeEntry()) as never);
    expect(tool.schema.safeParse({ content: "abc" }).success).toBe(true);
    expect(
      tool.schema.safeParse({ content: "abc", title: "T", tags: ["a"] })
        .success,
    ).toBe(true);
  });

  it("schema 拒绝缺少 content", () => {
    const tool = new MemoryAddTool(makeMemory(fakeEntry()) as never);
    expect(tool.schema.safeParse({ title: "T" }).success).toBe(false);
  });

  it("透传 content/title/tags 给 memory.add，返回 JSON 序列化 entry", async () => {
    const entry = fakeEntry({ title: "Meeting", tags: ["work"] });
    const mem = makeMemory(entry);
    const tool = new MemoryAddTool(mem as never);

    const out = await tool.execute(
      { content: "Discussed Q3 plans", title: "Meeting", tags: ["work"] },
      fakeCtx(),
    );

    expect(mem.add).toHaveBeenCalledWith({
      content: "Discussed Q3 plans",
      title: "Meeting",
      tags: ["work"],
    });
    const parsed = JSON.parse(out) as MemoryEntry;
    expect(parsed.id).toBe(entry.id);
    expect(parsed.title).toBe("Meeting");
    expect(parsed.tags).toEqual(["work"]);
  });

  it("无 title/tags 时仍正确调用 memory.add", async () => {
    const entry = fakeEntry({ title: "", tags: [] });
    const mem = makeMemory(entry);
    const tool = new MemoryAddTool(mem as never);

    await tool.execute({ content: "bare fact" }, fakeCtx());
    expect(mem.add).toHaveBeenCalledWith({
      content: "bare fact",
      title: undefined,
      tags: undefined,
    });
  });
});
