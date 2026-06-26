import { describe, expect, it } from "vitest";
import { buildSkillsBlock } from "../../src/graph/context-builder.js";

describe("buildSkillsBlock", () => {
  it("列出已装技能：- name: description，完整描述不截断", () => {
    const longDesc = "浏览器自动化。".repeat(50);
    const out = buildSkillsBlock([
      { name: "agent-browser-cli", description: "浏览器自动化" },
      { name: "context7", description: longDesc },
    ]);
    expect(out).toContain("<skills>");
    expect(out).toContain("</skills>");
    expect(out).toContain("- agent-browser-cli: 浏览器自动化");
    // 完整描述,不截断
    expect(out).toContain(`- context7: ${longDesc}`);
  });

  it("无技能：给出 skill_search_market / skill_install 引导,不留空", () => {
    const out = buildSkillsBlock([]);
    expect(out).toContain("<skills>");
    expect(out).toContain("skill_search_market");
    expect(out).toContain("skill_install");
  });

  it("描述为空的技能只显示名字", () => {
    const out = buildSkillsBlock([{ name: "bare", description: "" }]);
    expect(out).toContain("- bare");
    expect(out).not.toContain("- bare: ");
  });

  it("提示用 skill_load 加载完整说明再执行", () => {
    const out = buildSkillsBlock([{ name: "x", description: "d" }]);
    expect(out).toContain("skill_load");
  });
});
