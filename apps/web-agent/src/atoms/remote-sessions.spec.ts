import type { SessionSummary } from "@meshbot/types-agent";
import { createStore } from "jotai";
import {
  applyRemoteSessionListEventAtom,
  loadRemoteSessionsAtom,
  reloadTrackedRemoteSessionsAtom,
  remoteSessionsAtom,
} from "./remote-sessions";

// fetchRemoteSessions 是 loadRemoteSessionsAtom（reloadTrackedRemoteSessionsAtom
// 内部调用）唯一的网络依赖，mock 掉避免真实 REST 调用。
jest.mock("@/rest/remote-agent-sessions", () => ({
  fetchRemoteSessions: jest.fn(),
}));

import { fetchRemoteSessions } from "@/rest/remote-agent-sessions";

afterEach(() => jest.clearAllMocks());

function makeSession(id: string, agentId = "a1"): SessionSummary {
  return {
    id,
    title: `会话 ${id}`,
    status: "idle",
    pinned: false,
    pinnedAt: null,
    titleGenerated: false,
    modelConfigId: null,
    agentId,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  } as SessionSummary;
}

describe("applyRemoteSessionListEventAtom", () => {
  it("未加载过的远程 Agent（map 无 key）→ 忽略，不凭空造状态", () => {
    const store = createStore();
    store.set(applyRemoteSessionListEventAtom, {
      agentId: "a1",
      evt: { type: "created", session: makeSession("s1") },
    });
    expect(store.get(remoteSessionsAtom).a1).toBeUndefined();
  });

  it("已加载的远程 Agent → created 插入该 Agent 的会话列表", () => {
    const store = createStore();
    store.set(remoteSessionsAtom, {
      a1: { status: "loaded", sessions: [] },
    });
    store.set(applyRemoteSessionListEventAtom, {
      agentId: "a1",
      evt: { type: "created", session: makeSession("s1") },
    });
    expect(store.get(remoteSessionsAtom).a1.sessions.map((s) => s.id)).toEqual([
      "s1",
    ]);
  });

  it("created 同 id 幂等 → 不产生重复行（先到先得 + relay 重连补发场景）", () => {
    const store = createStore();
    const s = makeSession("s1");
    store.set(remoteSessionsAtom, { a1: { status: "loaded", sessions: [s] } });
    store.set(applyRemoteSessionListEventAtom, {
      agentId: "a1",
      evt: { type: "created", session: s },
    });
    expect(store.get(remoteSessionsAtom).a1.sessions.map((x) => x.id)).toEqual([
      "s1",
    ]);
  });

  it("deleted → 移除对应会话", () => {
    const store = createStore();
    store.set(remoteSessionsAtom, {
      a1: {
        status: "loaded",
        sessions: [makeSession("s1"), makeSession("s2")],
      },
    });
    store.set(applyRemoteSessionListEventAtom, {
      agentId: "a1",
      evt: { type: "deleted", sessionId: "s1" },
    });
    expect(store.get(remoteSessionsAtom).a1.sessions.map((x) => x.id)).toEqual([
      "s2",
    ]);
  });

  it("renamed → 改标题并置 titleGenerated=true", () => {
    const store = createStore();
    store.set(remoteSessionsAtom, {
      a1: { status: "loaded", sessions: [makeSession("s1")] },
    });
    store.set(applyRemoteSessionListEventAtom, {
      agentId: "a1",
      evt: { type: "renamed", sessionId: "s1", title: "新标题" },
    });
    expect(store.get(remoteSessionsAtom).a1.sessions[0]).toMatchObject({
      title: "新标题",
      titleGenerated: true,
    });
  });

  it("不串 Agent：事件只影响目标 agentId 的缓存，其余 Agent 原样不变（引用不变）", () => {
    const store = createStore();
    const other = {
      status: "loaded" as const,
      sessions: [makeSession("x", "a2")],
    };
    store.set(remoteSessionsAtom, {
      a1: { status: "loaded", sessions: [] },
      a2: other,
    });
    store.set(applyRemoteSessionListEventAtom, {
      agentId: "a1",
      evt: { type: "created", session: makeSession("s1") },
    });
    expect(store.get(remoteSessionsAtom).a2).toBe(other);
  });
});

describe("reloadTrackedRemoteSessionsAtom", () => {
  it("对 map 里已有的每个 agentId 强制重拉（force=true，覆盖 loaded 状态）", async () => {
    (fetchRemoteSessions as jest.Mock).mockImplementation(
      async (agentId: string) => [makeSession(`${agentId}-fresh`, agentId)],
    );
    const store = createStore();
    store.set(remoteSessionsAtom, {
      a1: { status: "loaded", sessions: [makeSession("stale", "a1")] },
      a2: { status: "error", sessions: [] },
    });
    store.set(reloadTrackedRemoteSessionsAtom);
    // loadRemoteSessionsAtom 的 write 是 async，await 一个微任务队列排空
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchRemoteSessions).toHaveBeenCalledWith("a1");
    expect(fetchRemoteSessions).toHaveBeenCalledWith("a2");
    expect(store.get(remoteSessionsAtom).a1.sessions.map((s) => s.id)).toEqual([
      "a1-fresh",
    ]);
  });

  it("map 为空 → 不发任何请求", () => {
    const store = createStore();
    store.set(reloadTrackedRemoteSessionsAtom);
    expect(fetchRemoteSessions).not.toHaveBeenCalled();
  });
});

describe("loadRemoteSessionsAtom（双写扫描 R2a：loading 期间清空导致闪烁+丢事件）", () => {
  it("force 重拉进入 loading 时旧 sessions 仍可读，直到新快照到达才整体覆盖", async () => {
    const store = createStore();
    const stale = makeSession("stale", "a1");
    store.set(remoteSessionsAtom, {
      a1: { status: "loaded", sessions: [stale] },
    });
    let resolveFetch: (v: SessionSummary[]) => void = () => {};
    (fetchRemoteSessions as jest.Mock).mockReturnValue(
      new Promise<SessionSummary[]>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const pending = store.set(loadRemoteSessionsAtom, "a1", true);
    // 尚未 resolve：status 已切到 loading，但旧数据不该被清空（无闪烁）
    expect(store.get(remoteSessionsAtom).a1.status).toBe("loading");
    expect(store.get(remoteSessionsAtom).a1.sessions).toEqual([stale]);

    resolveFetch([makeSession("fresh", "a1")]);
    await pending;

    expect(store.get(remoteSessionsAtom).a1.status).toBe("loaded");
    expect(store.get(remoteSessionsAtom).a1.sessions.map((s) => s.id)).toEqual([
      "fresh",
    ]);
  });

  it("首次加载（map 里无该 key）进入 loading 时 sessions 仍是空数组（没有旧值可保留）", async () => {
    const store = createStore();
    (fetchRemoteSessions as jest.Mock).mockReturnValue(new Promise(() => {}));

    store.set(loadRemoteSessionsAtom, "a1");
    expect(store.get(remoteSessionsAtom).a1).toEqual({
      status: "loading",
      sessions: [],
    });
  });
});
