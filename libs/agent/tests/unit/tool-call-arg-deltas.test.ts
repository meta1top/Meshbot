import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { extractToolCallArgDeltas } from "../../src/graph/graph.service.js";

describe("extractToolCallArgDeltas", () => {
  it("无 tool_call_chunks → 空数组", () => {
    const msg = new AIMessageChunk({ content: "hello" });
    expect(extractToolCallArgDeltas(msg)).toEqual([]);
  });

  it("抽取 index + name + args 增量", () => {
    const msg = new AIMessageChunk({
      content: "",
      tool_call_chunks: [
        { name: "write_file", args: '{"file_p', index: 0, id: "x" },
      ],
    });
    expect(extractToolCallArgDeltas(msg)).toEqual([
      { index: 0, name: "write_file", delta: '{"file_p' },
    ]);
  });

  it("index 缺失时回退 0", () => {
    const msg = new AIMessageChunk({
      content: "",
      tool_call_chunks: [{ args: "ath", id: "x" }],
    });
    expect(extractToolCallArgDeltas(msg)).toEqual([
      { index: 0, name: undefined, delta: "ath" },
    ]);
  });
});
