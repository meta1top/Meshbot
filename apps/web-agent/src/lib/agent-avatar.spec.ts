import { combineAgentAvatar, parseAgentAvatar } from "./agent-avatar";

describe("parseAgentAvatar", () => {
  it("拆开正常的 emoji|色值 两段式", () => {
    expect(parseAgentAvatar("🛠️|#3b82f6")).toEqual({
      emoji: "🛠️",
      color: "#3b82f6",
    });
  });

  it("缺色值时回退默认色值", () => {
    const parsed = parseAgentAvatar("🛠️");
    expect(parsed.emoji).toBe("🛠️");
    expect(parsed.color).toMatch(/^#/);
  });

  it("缺 emoji 时回退默认 emoji", () => {
    const parsed = parseAgentAvatar("|#3b82f6");
    expect(parsed.color).toBe("#3b82f6");
    expect(parsed.emoji.length).toBeGreaterThan(0);
  });

  it("空字符串整体回退默认头像", () => {
    const parsed = parseAgentAvatar("");
    expect(parsed.emoji.length).toBeGreaterThan(0);
    expect(parsed.color).toMatch(/^#/);
  });
});

describe("combineAgentAvatar", () => {
  it("正常合成 emoji|色值 两段式", () => {
    expect(combineAgentAvatar("🛠️", "#3b82f6")).toBe("🛠️|#3b82f6");
  });

  it("emoji 为空白时回退默认 emoji", () => {
    const combined = combineAgentAvatar("  ", "#3b82f6");
    expect(combined.endsWith("|#3b82f6")).toBe(true);
    expect(parseAgentAvatar(combined).emoji.length).toBeGreaterThan(0);
  });

  it("色值为空白时回退默认色值", () => {
    const combined = combineAgentAvatar("🛠️", "  ");
    expect(parseAgentAvatar(combined).color).toMatch(/^#/);
  });

  it("与 parseAgentAvatar 互为逆操作", () => {
    const combined = combineAgentAvatar("🚀", "#22c55e");
    expect(parseAgentAvatar(combined)).toEqual({
      emoji: "🚀",
      color: "#22c55e",
    });
  });
});
