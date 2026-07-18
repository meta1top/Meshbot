import type { SessionSummary } from "@meshbot/types-agent";
import { patchSessionStatus } from "./sessions";

function makeSession(id: string, status: "idle" | "running"): SessionSummary {
  return {
    id,
    title: `会话 ${id}`,
    status,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  } as SessionSummary;
}

describe("patchSessionStatus", () => {
  it("命中 id → 只改该条 status，其余不动", () => {
    const arr = [makeSession("a", "running"), makeSession("b", "running")];
    const next = patchSessionStatus(arr, "a", "idle");
    expect(next.map((s) => s.status)).toEqual(["idle", "running"]);
    expect(next[1]).toBe(arr[1]);
  });

  it("id 不在列表里 → 原样返回，不插入新行", () => {
    const arr = [makeSession("a", "idle")];
    const next = patchSessionStatus(arr, "quick-999", "running");
    expect(next).toBe(arr);
    expect(next).toHaveLength(1);
  });

  it("空列表 → 原样返回", () => {
    const arr: SessionSummary[] = [];
    expect(patchSessionStatus(arr, "a", "idle")).toBe(arr);
  });
});
