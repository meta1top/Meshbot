import { parseAgentAvatar } from "./agent-avatar";

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
