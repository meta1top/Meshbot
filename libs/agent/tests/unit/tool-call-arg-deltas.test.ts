import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import {
  extractToolCallArgDeltas,
  resolveToolCallId,
} from "../../src/graph/graph-runner.service.js";

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

describe("resolveToolCallId", () => {
  it("按 index 取 tool_call 稳定 id", () => {
    const acc = new AIMessageChunk({
      content: "",
      tool_call_chunks: [
        { name: "write_file", args: "{}", index: 0, id: "call_a" },
        { name: "bash", args: "{}", index: 1, id: "call_b" },
      ],
    });
    expect(resolveToolCallId(acc, 0)).toBe("call_a");
    expect(resolveToolCallId(acc, 1)).toBe("call_b");
  });

  it("id 缺失 / index 不存在 → undefined", () => {
    const acc = new AIMessageChunk({
      content: "",
      tool_call_chunks: [{ args: "ath", index: 0 }],
    });
    expect(resolveToolCallId(acc, 0)).toBeUndefined();
    expect(resolveToolCallId(acc, 9)).toBeUndefined();
  });

  it("首片带 id、后续 args 片不带 id：concat 后仍按 index 对得上", () => {
    // 真实流式形态：第一片给 id+name，后续片只有 args 增量、无 id。
    const first = new AIMessageChunk({
      content: "",
      tool_call_chunks: [
        { name: "write_file", args: '{"file_p', index: 0, id: "call_x" },
      ],
    });
    const next = new AIMessageChunk({
      content: "",
      tool_call_chunks: [{ args: 'ath":"a"}', index: 0 }],
    });
    const acc = first.concat(next);
    expect(resolveToolCallId(acc, 0)).toBe("call_x");
  });
});
