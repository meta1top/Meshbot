import type { SessionSummary } from "@meshbot/types-agent";
import { groupSessionsByAgent } from "./group-sessions-by-agent";

const s = (id: string, agentId: string, status: "idle" | "running" = "idle") =>
  ({
    id,
    agentId,
    status,
    title: id,
    pinned: false,
    pinnedAt: null,
    titleGenerated: true,
    modelConfigId: null,
  }) as SessionSummary;

describe("groupSessionsByAgent", () => {
  it("按 agentId 分组，每组只含自己的会话", () => {
    const groups = groupSessionsByAgent(
      [{ id: "a" }, { id: "b" }],
      [s("1", "a"), s("2", "b"), s("3", "a")],
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].sessions.map((x) => x.id)).toEqual(["1", "3"]);
    expect(groups[1].sessions.map((x) => x.id)).toEqual(["2"]);
  });

  it("某 Agent 有 running 会话 → running=true", () => {
    const groups = groupSessionsByAgent(
      [{ id: "a" }, { id: "b" }],
      [s("1", "a", "running"), s("2", "b")],
    );
    expect(groups.find((g) => g.agentId === "a")?.running).toBe(true);
    expect(groups.find((g) => g.agentId === "b")?.running).toBe(false);
  });

  it("零会话的 Agent 仍出现，sessions 空、running=false", () => {
    const groups = groupSessionsByAgent([{ id: "a" }], []);
    expect(groups[0]).toEqual({ agentId: "a", sessions: [], running: false });
  });
});
