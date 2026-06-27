import { describe, expect, it } from "@jest/globals";
import { describeRoute, formatLlmuseBlock } from "./llmuse";

describe("describeRoute", () => {
  it("助手会话页", () => {
    expect(describeRoute("/messages", true)).toBe("助手会话");
  });
  it("消息页", () => {
    expect(describeRoute("/messages", false)).toBe("消息");
  });
  it("日程页", () => {
    expect(describeRoute("/schedule", false)).toBe("日程");
  });
  it("未知页回退路径", () => {
    expect(describeRoute("/foo", false)).toBe("/foo");
  });
});

describe("formatLlmuseBlock", () => {
  it("含会话上下文", () => {
    const block = formatLlmuseBlock({
      pageLabel: "消息",
      conversation: { id: "321", type: "channel", name: "产品研发", unread: 5 },
    });
    expect(block).toContain("<llmuse>");
    expect(block).toContain("页面: 消息");
    expect(block).toContain("会话: 产品研发 (channel, id=321), 未读 5");
    expect(block).toContain("</llmuse>");
  });
  it("无会话只放页面行", () => {
    const block = formatLlmuseBlock({ pageLabel: "日程", conversation: null });
    expect(block).toContain("页面: 日程");
    expect(block).not.toContain("会话:");
  });
});
