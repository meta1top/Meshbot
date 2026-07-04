import { describe, expect, it } from "@jest/globals";
import { describeRoute, formatLlmuseBlock } from "./llmuse";

describe("describeRoute", () => {
  it("助手会话页", () => {
    expect(describeRoute("/assistant")).toBe("助手会话");
  });
  it("消息页", () => {
    expect(describeRoute("/messages")).toBe("消息");
  });
  it("技能页", () => {
    expect(describeRoute("/skills")).toBe("技能");
  });
  it("文件页", () => {
    expect(describeRoute("/drive")).toBe("文件");
  });
  it("流程页", () => {
    expect(describeRoute("/flows")).toBe("流程");
  });
  it("设置页（更多）", () => {
    expect(describeRoute("/more")).toBe("设置");
  });
  it("设置页（定时任务）", () => {
    expect(describeRoute("/schedule")).toBe("设置");
  });
  it("未知页回退路径", () => {
    expect(describeRoute("/foo")).toBe("/foo");
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
