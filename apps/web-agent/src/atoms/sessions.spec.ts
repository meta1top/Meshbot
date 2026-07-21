import type { SessionSummary } from "@meshbot/types-agent";
import { createStore } from "jotai";
import {
  deleteSession as deleteSessionApi,
  patchSession as patchSessionApi,
} from "@/rest/session";
import {
  addSessionAtom,
  applySessionListEventAtom,
  applySessionListEventToArray,
  deleteSessionAtom,
  patchSessionStatus,
  renameSessionAtom,
  SELF_DELETE_GRACE_MS,
  selfDeletingSessionIdsAtom,
  sessionsAtom,
  updateSessionStatusAtom,
} from "./sessions";

// deleteSessionAtom 唯一的网络依赖，mock 掉避免真实 REST 调用；deleteSessionAtom
// 自身测试需要控制它的 resolve 时机（模拟「回声先到 / 后到」两种顺序）。
jest.mock("@/rest/session", () => ({
  deleteSession: jest.fn(),
  listSessions: jest.fn(),
  patchSession: jest.fn(),
}));

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

describe("deleteSessionAtom / selfDeletingSessionIdsAtom（真机验收缺陷：删除会话后主内容区不跟随）", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (deleteSessionApi as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("发起删除时同步标记 selfDeletingSessionIdsAtom——先于网络 I/O 完成（happens-before ws 回声）", async () => {
    const store = createStore();
    store.set(sessionsAtom, [makeSession("s1", "idle")]);
    let resolveDelete: () => void = () => {};
    (deleteSessionApi as jest.Mock).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );

    const pending = store.set(deleteSessionAtom, "s1");
    // 网络请求尚未 resolve，标记必须已经同步写入（不能等 REST 响应回来才标记，
    // 否则 ws 回声先到时会被误判成「别的设备删的」，见 selfDeletingSessionIdsAtom 文档）。
    expect(store.get(selfDeletingSessionIdsAtom).has("s1")).toBe(true);

    resolveDelete();
    await pending;
    expect(store.get(sessionsAtom)).toHaveLength(0);
  });

  it(`宽限期（SELF_DELETE_GRACE_MS=${SELF_DELETE_GRACE_MS}ms）后自动清除标记`, async () => {
    const store = createStore();
    store.set(sessionsAtom, [makeSession("s1", "idle")]);
    (deleteSessionApi as jest.Mock).mockResolvedValue(undefined);

    await store.set(deleteSessionAtom, "s1");
    expect(store.get(selfDeletingSessionIdsAtom).has("s1")).toBe(true);

    jest.advanceTimersByTime(SELF_DELETE_GRACE_MS);
    expect(store.get(selfDeletingSessionIdsAtom).has("s1")).toBe(false);
  });

  it("宽限期未到 → 标记仍在（宽限期不是「立即清」）", async () => {
    const store = createStore();
    store.set(sessionsAtom, [makeSession("s1", "idle")]);
    (deleteSessionApi as jest.Mock).mockResolvedValue(undefined);

    await store.set(deleteSessionAtom, "s1");
    jest.advanceTimersByTime(SELF_DELETE_GRACE_MS - 1);
    expect(store.get(selfDeletingSessionIdsAtom).has("s1")).toBe(true);
  });

  it("标记/清除只影响自己这条 id，不动集合里已有的其他标记", async () => {
    const store = createStore();
    store.set(sessionsAtom, [
      makeSession("s1", "idle"),
      makeSession("s2", "idle"),
    ]);
    store.set(selfDeletingSessionIdsAtom, new Set(["s2"]));
    (deleteSessionApi as jest.Mock).mockResolvedValue(undefined);

    await store.set(deleteSessionAtom, "s1");
    expect(store.get(selfDeletingSessionIdsAtom)).toEqual(
      new Set(["s2", "s1"]),
    );

    jest.advanceTimersByTime(SELF_DELETE_GRACE_MS);
    expect(store.get(selfDeletingSessionIdsAtom)).toEqual(new Set(["s2"]));
  });

  it("id 不在列表里 → no-op：不调用删除接口、不标记 selfDeletingSessionIdsAtom", async () => {
    const store = createStore();
    store.set(sessionsAtom, [makeSession("s1", "idle")]);

    await store.set(deleteSessionAtom, "不存在的会话");

    expect(deleteSessionApi).not.toHaveBeenCalled();
    expect(store.get(selfDeletingSessionIdsAtom).size).toBe(0);
  });
});

describe("deleteSessionAtom 的自删宽限期锚点（review Important 3）", () => {
  it("宽限计时从 REST 完成才开始 —— 慢删除（>宽限期）不会让自己的删除被当成他人删除", async () => {
    jest.useFakeTimers();
    try {
      const store = createStore();
      store.set(sessionsAtom, [makeSession("slow", "idle")]);
      // 模拟一次比宽限期还慢的删除（SQLite 与正在跑的 run 抢锁，
      // busy_timeout=5000 让 >3s 的写够得着）
      let resolveDelete: (() => void) | undefined;
      (deleteSessionApi as jest.Mock).mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolveDelete = r;
          }),
      );
      const p = store.set(deleteSessionAtom, "slow");

      // 宽限期已过，但 REST 还没回来——标记必须仍在，否则回声一到就误报
      jest.advanceTimersByTime(SELF_DELETE_GRACE_MS + 1000);
      expect(store.get(selfDeletingSessionIdsAtom).has("slow")).toBe(true);

      resolveDelete?.();
      await p;
      // REST 完成后才起计时，此刻仍在宽限期内
      expect(store.get(selfDeletingSessionIdsAtom).has("slow")).toBe(true);
      jest.advanceTimersByTime(SELF_DELETE_GRACE_MS + 1);
      expect(store.get(selfDeletingSessionIdsAtom).has("slow")).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("删除失败 → 标记立刻清掉（否则之后在别的设备真被删时收不到提示）", async () => {
    const store = createStore();
    store.set(sessionsAtom, [makeSession("boom", "idle")]);
    (deleteSessionApi as jest.Mock).mockRejectedValueOnce(
      new Error("网络炸了"),
    );
    await expect(store.set(deleteSessionAtom, "boom")).rejects.toThrow(
      /网络炸了/,
    );
    expect(store.get(selfDeletingSessionIdsAtom).has("boom")).toBe(false);
  });
});

describe("renameSessionAtom（双写扫描 R1：回滚/成功路径整对象替换会盖掉别人的写入）", () => {
  beforeEach(() => {
    (patchSessionApi as jest.Mock).mockReset();
  });

  it("空标题或与原值相同 → no-op，不发请求，不改列表", async () => {
    const store = createStore();
    const s = makeSession("s1", "idle");
    store.set(sessionsAtom, [s]);

    await store.set(renameSessionAtom, { id: "s1", title: "   " });
    await store.set(renameSessionAtom, { id: "s1", title: s.title });

    expect(patchSessionApi).not.toHaveBeenCalled();
    expect(store.get(sessionsAtom)[0]).toBe(s);
  });

  it("id 不在列表里 → no-op，不发请求", async () => {
    const store = createStore();
    store.set(sessionsAtom, [makeSession("s1", "idle")]);

    await store.set(renameSessionAtom, { id: "不存在", title: "新标题" });

    expect(patchSessionApi).not.toHaveBeenCalled();
  });

  it("成功路径：只合并服务端返回的 title/titleGenerated，不整体替换——await 窗口内别的写入（status）不丢", async () => {
    const store = createStore();
    store.set(sessionsAtom, [makeSession("s1", "idle")]);
    let resolvePatch: (v: SessionSummary) => void = () => {};
    (patchSessionApi as jest.Mock).mockReturnValue(
      new Promise<SessionSummary>((resolve) => {
        resolvePatch = resolve;
      }),
    );

    const pending = store.set(renameSessionAtom, {
      id: "s1",
      title: "新标题",
    });
    // 乐观更新已应用
    expect(store.get(sessionsAtom)[0].title).toBe("新标题");

    // await 窗口内：runner 起了一个 run，status_changed 把 status patch 成
    // running（与 renameSessionAtom 完全无关的一次写入）。
    store.set(updateSessionStatusAtom, { id: "s1", status: "running" });
    expect(store.get(sessionsAtom)[0].status).toBe("running");

    // 服务端响应带着它自己读到的（此刻已经过期的）status 快照，不该覆盖上面
    // 那次并发写入。
    resolvePatch({
      ...makeSession("s1", "idle"),
      title: "新标题",
      titleGenerated: true,
    });
    await pending;

    const after = store.get(sessionsAtom)[0];
    expect(after.title).toBe("新标题");
    expect(after.titleGenerated).toBe(true);
    expect(after.status).toBe("running");
  });

  it("失败回滚：只还原 title/titleGenerated，不碰 await 窗口内变化的 status", async () => {
    const store = createStore();
    store.set(sessionsAtom, [makeSession("s1", "idle")]);
    let rejectPatch: (e: unknown) => void = () => {};
    (patchSessionApi as jest.Mock).mockReturnValue(
      new Promise<SessionSummary>((_resolve, reject) => {
        rejectPatch = reject;
      }),
    );

    const pending = store.set(renameSessionAtom, {
      id: "s1",
      title: "新标题",
    });
    expect(store.get(sessionsAtom)[0].title).toBe("新标题");

    // await 窗口内并发的 status 写入（同上一测试）
    store.set(updateSessionStatusAtom, { id: "s1", status: "running" });

    rejectPatch(new Error("网络炸了"));
    await expect(pending).rejects.toThrow(/网络炸了/);

    const after = store.get(sessionsAtom)[0];
    // title 回滚到改名前
    expect(after.title).toBe(`会话 s1`);
    expect(after.titleGenerated).toBe(false);
    // status 是回滚窗口内发生的另一次写入，不该被这次回滚吞掉
    expect(after.status).toBe("running");
  });
});
