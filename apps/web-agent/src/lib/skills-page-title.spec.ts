import { resolveSkillsTitleKind } from "./skills-page-title";

describe("resolveSkillsTitleKind", () => {
  it("agent 态 + 已知 Agent 名 → agent 分支带上名字（Bug #10 核心场景）", () => {
    expect(
      resolveSkillsTitleKind({
        mode: "agent",
        activeView: "system",
        selectedAgentName: "星黛露",
      }),
    ).toEqual({ kind: "agent", name: "星黛露" });
  });

  it("agent 态 + Agent 列表尚未到达（名字未知）→ agent 分支 name 为 undefined，而非落到 market", () => {
    expect(
      resolveSkillsTitleKind({ mode: "agent", activeView: "system" }),
    ).toEqual({ kind: "agent", name: undefined });
  });

  it("market 态 → market 分支携带当前来源，不受 selectedAgentName 影响", () => {
    expect(
      resolveSkillsTitleKind({
        mode: "market",
        activeView: "system",
        selectedAgentName: "星黛露",
      }),
    ).toEqual({ kind: "market", source: "system" });

    expect(
      resolveSkillsTitleKind({ mode: "market", activeView: "clawhub" }),
    ).toEqual({ kind: "market", source: "clawhub" });
  });

  it("mode 与 activeView 互斥（Bug #3）：同一次调用只会落到一个分支", () => {
    const agentResult = resolveSkillsTitleKind({
      mode: "agent",
      activeView: "clawhub", // 即便 activeView 残留着上次的市场来源
      selectedAgentName: "M",
    });
    expect(agentResult.kind).toBe("agent");
  });
});
