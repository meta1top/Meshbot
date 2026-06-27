import { describe, expect, it } from "@jest/globals";
import { LLMUSE_CLOSE, LLMUSE_OPEN, stripLlmuse } from "./llmuse";

describe("stripLlmuse", () => {
  it("剥离前置块 + 紧邻换行，保留用户原文", () => {
    const raw = `${LLMUSE_OPEN}\n页面: 消息\n${LLMUSE_CLOSE}\n帮我看一下`;
    expect(stripLlmuse(raw)).toBe("帮我看一下");
  });

  it("无块时原样返回", () => {
    expect(stripLlmuse("普通消息")).toBe("普通消息");
  });

  it("剥离多个块", () => {
    const raw = `${LLMUSE_OPEN}a${LLMUSE_CLOSE}\n${LLMUSE_OPEN}b${LLMUSE_CLOSE}\n正文`;
    expect(stripLlmuse(raw)).toBe("正文");
  });

  it("未闭合标签不误伤正文（无闭合即不剥离）", () => {
    const raw = `${LLMUSE_OPEN}没有闭合的正文`;
    expect(stripLlmuse(raw)).toBe(`${LLMUSE_OPEN}没有闭合的正文`);
  });
});
