import {
  SESSION_LIFECYCLE_EVENTS,
  SESSION_STATUS_EVENTS,
} from "@meshbot/types-agent";
import {
  applySessionListEvent,
  toSessionListEvent,
} from "./session-list-events";

const s = (id: string, over = {}) => ({
  id,
  title: `会话${id}`,
  status: "idle" as const,
  pinned: false,
  pinnedAt: null,
  titleGenerated: false,
  modelConfigId: null,
  agentId: "a1",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  ...over,
});

describe("toSessionListEvent", () => {
  it("识别四类生命周期事件", () => {
    expect(
      toSessionListEvent(SESSION_LIFECYCLE_EVENTS.created, {
        agentId: "a1",
        session: s("s1"),
      }),
    ).toEqual({ type: "created", session: s("s1") });
    expect(
      toSessionListEvent(SESSION_LIFECYCLE_EVENTS.deleted, {
        agentId: "a1",
        sessionId: "s1",
      }),
    ).toEqual({ type: "deleted", sessionId: "s1" });
    expect(
      toSessionListEvent(SESSION_LIFECYCLE_EVENTS.renamed, {
        agentId: "a1",
        sessionId: "s1",
        title: "新",
      }),
    ).toEqual({ type: "renamed", sessionId: "s1", title: "新" });
    expect(
      toSessionListEvent(SESSION_STATUS_EVENTS.changed, {
        agentId: "a1",
        sessionId: "s1",
        status: "running",
      }),
    ).toEqual({ type: "status_changed", sessionId: "s1", status: "running" });
  });

  it("推理帧等其它事件返 null", () => {
    expect(toSessionListEvent("run.chunk", { sessionId: "s1" })).toBeNull();
  });

  it("payload 形状不符返 null，不抛（relay 透传 unknown）", () => {
    expect(
      toSessionListEvent(SESSION_LIFECYCLE_EVENTS.deleted, "乱七八糟"),
    ).toBeNull();
    expect(
      toSessionListEvent(SESSION_LIFECYCLE_EVENTS.created, { agentId: "a1" }),
    ).toBeNull();
  });
});

describe("applySessionListEvent", () => {
  it("created 插到列表最前（新会话在顶）", () => {
    expect(
      applySessionListEvent([s("s1")], {
        type: "created",
        session: s("s2"),
      }).map((x) => x.id),
    ).toEqual(["s2", "s1"]);
  });

  it("created 重复 id 不产生重复行（幂等）", () => {
    expect(
      applySessionListEvent([s("s1")], {
        type: "created",
        session: s("s1"),
      }).map((x) => x.id),
    ).toEqual(["s1"]);
  });

  it("deleted 移除", () => {
    expect(
      applySessionListEvent([s("s1"), s("s2")], {
        type: "deleted",
        sessionId: "s1",
      }).map((x) => x.id),
    ).toEqual(["s2"]);
  });

  it("renamed 改标题并置 titleGenerated", () => {
    const out = applySessionListEvent([s("s1")], {
      type: "renamed",
      sessionId: "s1",
      title: "新名",
    });
    expect(out[0]).toMatchObject({ title: "新名", titleGenerated: true });
  });

  it("status_changed 改状态", () => {
    const out = applySessionListEvent([s("s1")], {
      type: "status_changed",
      sessionId: "s1",
      status: "running",
    });
    expect(out[0].status).toBe("running");
  });

  it("列表里没有的会话：非 created 事件被忽略（不凭空造行）", () => {
    const list = [s("s1")];
    expect(
      applySessionListEvent(list, {
        type: "renamed",
        sessionId: "不存在",
        title: "x",
      }),
    ).toEqual(list);
    expect(
      applySessionListEvent(list, { type: "deleted", sessionId: "不存在" }),
    ).toEqual(list);
  });

  it("不可变：不修改传入数组", () => {
    const list = [s("s1")];
    applySessionListEvent(list, {
      type: "renamed",
      sessionId: "s1",
      title: "新",
    });
    expect(list[0].title).toBe("会话s1");
  });
});
