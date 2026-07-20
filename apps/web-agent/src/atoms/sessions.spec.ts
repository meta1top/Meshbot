import type { SessionSummary } from "@meshbot/types-agent";
import { createStore } from "jotai";
import {
  addSessionAtom,
  applySessionListEventAtom,
  applySessionListEventToArray,
  patchSessionStatus,
  sessionsAtom,
} from "./sessions";

function makeSession(
  id: string,
  status: "idle" | "running",
  updatedAt = "2026-07-18T00:00:00.000Z",
): SessionSummary {
  return {
    id,
    title: `会话 ${id}`,
    status,
    pinned: false,
    pinnedAt: null,
    titleGenerated: false,
    modelConfigId: null,
    agentId: "a1",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt,
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

describe("applySessionListEventToArray", () => {
  it("created → 插入新会话（按 updatedAt 排到应在的位置）", () => {
    const arr = [
      makeSession("a", "idle", "2026-07-18T00:00:01.000Z"),
      makeSession("b", "idle", "2026-07-18T00:00:00.000Z"),
    ];
    const newSession = makeSession("c", "running", "2026-07-18T00:00:02.000Z");
    const next = applySessionListEventToArray(arr, {
      type: "created",
      session: newSession,
    });
    expect(next.map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("created 同 id 幂等 → 不产生重复行", () => {
    const arr = [makeSession("a", "idle")];
    const next = applySessionListEventToArray(arr, {
      type: "created",
      session: makeSession("a", "idle"),
    });
    expect(next.map((s) => s.id)).toEqual(["a"]);
  });

  it("deleted → 移除对应会话", () => {
    const arr = [makeSession("a", "idle"), makeSession("b", "idle")];
    const next = applySessionListEventToArray(arr, {
      type: "deleted",
      sessionId: "a",
    });
    expect(next.map((s) => s.id)).toEqual(["b"]);
  });

  it("renamed → 改标题并置 titleGenerated=true", () => {
    const arr = [makeSession("a", "idle")];
    const next = applySessionListEventToArray(arr, {
      type: "renamed",
      sessionId: "a",
      title: "新标题",
    });
    expect(next[0]).toMatchObject({ title: "新标题", titleGenerated: true });
  });

  it("不认识的会话（deleted/renamed 命中不到 id）→ 原样返回，引用不变，不插入新行", () => {
    const arr = [makeSession("a", "idle")];
    const deletedNext = applySessionListEventToArray(arr, {
      type: "deleted",
      sessionId: "不存在",
    });
    expect(deletedNext).toBe(arr);
    const renamedNext = applySessionListEventToArray(arr, {
      type: "renamed",
      sessionId: "不存在",
      title: "x",
    });
    expect(renamedNext).toBe(arr);
  });

  it("不可变：不修改传入数组", () => {
    const arr = [makeSession("a", "idle")];
    applySessionListEventToArray(arr, {
      type: "renamed",
      sessionId: "a",
      title: "改了",
    });
    expect(arr[0].title).toBe("会话 a");
  });
});

describe("addSessionAtom（真机缺陷：本地建会话侧栏出现两条）", () => {
  it("同一会话经 ws 事件与 REST 响应两条路径先后到达 → 只有一条", () => {
    const store = createStore();
    const s = makeSession("s1", "running");
    // ws 是常驻连接，`session.created` 常常先于 HTTP 响应到达浏览器
    store.set(applySessionListEventAtom, { type: "created", session: s });
    // 随后 REST 响应回来，调用方拿着同一条 summary 调 addSessionAtom
    store.set(addSessionAtom, s);
    expect(store.get(sessionsAtom).map((x) => x.id)).toEqual(["s1"]);
  });

  it("反序（REST 先、事件后）同样只有一条", () => {
    const store = createStore();
    const s = makeSession("s2", "running");
    store.set(addSessionAtom, s);
    store.set(applySessionListEventAtom, { type: "created", session: s });
    expect(store.get(sessionsAtom).map((x) => x.id)).toEqual(["s2"]);
  });

  it("不同会话照常各插一条", () => {
    const store = createStore();
    store.set(addSessionAtom, makeSession("a", "idle"));
    store.set(addSessionAtom, makeSession("b", "idle"));
    expect(
      store
        .get(sessionsAtom)
        .map((x) => x.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});
