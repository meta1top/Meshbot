import { sanitizeMeshbotPaths, toolDisplayName } from "./tool-display";

describe("toolDisplayName", () => {
  it("内置工具映射友好中文名", () => {
    expect(toolDisplayName("im_read_conversation")).toBe("读取会话");
    expect(toolDisplayName("skill_search_market")).toBe("搜索技能市场");
    expect(toolDisplayName("im_list_members")).toBe("成员列表");
  });
  it("未收录工具兜底为下划线转空格（不暴露 snake 原名）", () => {
    expect(toolDisplayName("foo_bar_baz")).toBe("foo bar baz");
  });
});

describe("sanitizeMeshbotPaths", () => {
  it("绝对路径 .meshbot 前缀 → <工作区>，保留其后相对部分", () => {
    expect(sanitizeMeshbotPaths("/Users/grant/.meshbot/skills/foo")).toBe(
      "<工作区>/skills/foo",
    );
  });
  it("家目录 ~/.meshbot 同样隐藏", () => {
    expect(sanitizeMeshbotPaths("~/.meshbot/memory/core.md")).toBe(
      "<工作区>/memory/core.md",
    );
  });
  it("项目内 .meshbot 路径隐藏", () => {
    expect(
      sanitizeMeshbotPaths("/Users/grant/Meta1/meshbot/.meshbot/mcp.json"),
    ).toBe("<工作区>/mcp.json");
  });
  it("JSON 文本里的路径也打码", () => {
    expect(sanitizeMeshbotPaths('{"path":"/home/u/.meshbot/x"}')).toBe(
      '{"path":"<工作区>/x"}',
    );
  });
  it("无 .meshbot 路径的文本原样返回", () => {
    expect(sanitizeMeshbotPaths("conversationId: 194164")).toBe(
      "conversationId: 194164",
    );
  });
});
