import type { SessionSummary } from "@meshbot/types-agent";
import { filterSessionsByAgent } from "./filter-sessions-by-agent";

function makeSession(id: string, agentId: string): SessionSummary {
  return {
    id,
    title: id,
    status: "idle",
    pinned: false,
    pinnedAt: null,
    titleGenerated: false,
    modelConfigId: null,
    agentId,
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
}

describe("filterSessionsByAgent", () => {
  it("只保留 agentId 匹配当前 Agent 的会话", () => {
    const sessions = [
      makeSession("s1", "agent-a"),
      makeSession("s2", "agent-b"),
      makeSession("s3", "agent-a"),
    ];
    const result = filterSessionsByAgent(sessions, "agent-a");
    expect(result.map((s) => s.id)).toEqual(["s1", "s3"]);
  });

  it("currentAgentId 为 null 时不过滤（首屏 Agent 未解析完成的短暂窗口）", () => {
    const sessions = [
      makeSession("s1", "agent-a"),
      makeSession("s2", "agent-b"),
    ];
    expect(filterSessionsByAgent(sessions, null)).toEqual(sessions);
  });

  it("没有匹配项时返回空数组（而非报错或原样返回）", () => {
    const sessions = [makeSession("s1", "agent-a")];
    expect(filterSessionsByAgent(sessions, "agent-zzz")).toEqual([]);
  });
});
