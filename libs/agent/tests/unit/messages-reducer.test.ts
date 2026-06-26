import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { mergeMessages } from "../../src/graph/graph.builder.js";

describe("mergeMessages（messages 通道 reducer）", () => {
  it("新 id 追加到末尾", () => {
    const base = [new SystemMessage({ id: "a", content: "A" })];
    const out = mergeMessages(base, [
      new HumanMessage({ id: "b", content: "B" }),
    ]);
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("同 id 原地替换：位置不变、内容更新、不重复", () => {
    const base = [
      new SystemMessage({ id: "system:ctx", content: "old" }),
      new HumanMessage({ id: "h1", content: "hi" }),
    ];
    const out = mergeMessages(base, [
      new SystemMessage({ id: "system:ctx", content: "new" }),
    ]);
    expect(out.map((m) => m.id)).toEqual(["system:ctx", "h1"]);
    expect(out[0].content).toBe("new");
  });

  it("RemoveMessage 按 id 删除", () => {
    const base = [
      new SystemMessage({ id: "system:ctx", content: "x" }),
      new HumanMessage({ id: "h1", content: "hi" }),
    ];
    const out = mergeMessages(base, [new RemoveMessage({ id: "system:ctx" })]);
    expect(out.map((m) => m.id)).toEqual(["h1"]);
  });

  it("同批 RemoveMessage(id) + 同 id 新消息 → 删原位、追加末尾（兼容旧 remove-then-add）", () => {
    const base = [
      new SystemMessage({ id: "system:ctx", content: "old" }),
      new HumanMessage({ id: "h1", content: "hi" }),
    ];
    const out = mergeMessages(base, [
      new RemoveMessage({ id: "system:ctx" }),
      new SystemMessage({ id: "system:ctx", content: "new" }),
    ]);
    expect(out.map((m) => m.id)).toEqual(["h1", "system:ctx"]);
    expect(out[1].content).toBe("new");
  });

  it("无 id 的消息照常追加（不参与 upsert）", () => {
    const base = [new SystemMessage({ id: "a", content: "A" })];
    const out = mergeMessages(base, [new AIMessage({ content: "no-id" })]);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("a");
  });
});
