// mock atoms/hooks dependencies（纯函数测试不需要真实 jotai/react/socket）
jest.mock("@/atoms/im", () => ({}));
jest.mock("@/atoms/schedule-activity", () => ({}));
jest.mock("@/atoms/sessions", () => ({}));
jest.mock("@/atoms/remote-sessions", () => ({}));
jest.mock("@/atoms/devices", () => ({}));
jest.mock("@/atoms/assistant-panel", () => ({}));
// 缺陷 1 引入：本机/远程「当前打开会话被删除」判定需要读它（use-global-events.ts
// 新增的 useAtomValue(activeAssistantSessionAtom) 调用点）。不桩会真的加载
// 该模块——它在真实（未 mock 的）"jotai" 上调用 atom(null)，而 "jotai" 本身
// 被下方整体替换掉，atom 会是 undefined，模块顶层求值直接抛错。
jest.mock("@/atoms/active-session", () => ({}));
jest.mock("@meshbot/web-common", () => ({ clearAccessToken: jest.fn() }));
jest.mock("@/rest/remote-agents", () => ({
  remoteAgentsQueryKey: ["remote-agents"],
}));
jest.mock("@/rest/agents", () => ({ agentsQueryKey: ["agents"] }));
jest.mock("@/lib/events-socket", () => ({ getEventsSocket: jest.fn() }));
// 缺陷 1 引入：window.alert + router.push("/assistant")，node 测试环境本无
// window/next-intl/next-navigation，同样需要桩掉（见下方三个 jest.mock）。
jest.mock("next-intl", () => ({ useTranslations: jest.fn() }));
jest.mock("next/navigation", () => ({ useRouter: jest.fn() }));
// useSetAtom 默认返回一个空操作函数（而非 undefined）：本文件的 handlers 对象
// 会把每个 useSetAtom(...) 的返回值直接当函数调用（如 onConnect 里新增的
// reloadTrackedRemoteSessions()）——保持 undefined 会让任何触达这些调用路径
// 的测试炸 `undefined is not a function`。各 atom 模块本身已被上面整体 mock 成
// `{}`，测试无法也无需按具体 atom 区分返回值，只需保证「可调用」。
// useAtomValue 默认也桩成 jest.fn()（无默认返回值）：各测试按需
// `mockReturnValueOnce` 两次，对应 use-global-events.ts 里
// activeAssistantSessionAtom → selfDeletingSessionIdsAtom 的调用顺序
// （mock 不认 atom 参数身份，只认调用顺序，够用且简单）。
jest.mock("jotai", () => ({
  useSetAtom: jest.fn(() => jest.fn()),
  useAtomValue: jest.fn(),
}));
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  useEffect: jest.fn(),
  // 缺陷 1 引入的 activeSessionRef/selfDeletingIdsRef：真实 useRef 需要 React
  // 渲染期的 hook dispatcher，renderHook 之外直接调用 useGlobalEvents() 拿不到
  // （本文件历来的测试方式，不走 renderHook），桩成最简单的可变容器即可。
  useRef: jest.fn((init: unknown) => ({ current: init })),
}));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: jest.fn() }));

import { AUTH_WS_EVENTS, IM_WS_EVENTS } from "@meshbot/types";
import {
  AGENT_EVENTS,
  MODEL_CONFIG_EVENTS,
  QUICK_ASSISTANT_EVENTS,
  REMOTE_AGENT_EVENTS,
  SCHEDULE_EVENTS,
  SESSION_LIFECYCLE_EVENTS,
  SESSION_STATUS_EVENTS,
} from "@meshbot/types-agent";
import { useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { getEventsSocket } from "@/lib/events-socket";
import { agentsQueryKey } from "@/rest/agents";
import { remoteAgentsQueryKey } from "@/rest/remote-agents";
import { dispatchGlobalEvent, useGlobalEvents } from "./use-global-events";

function makeHandlers() {
  return {
    onMessage: jest.fn(),
    onPresence: jest.fn(),
    onConversationCreated: jest.fn(),
    onConversationRemoved: jest.fn(),
    onConversationRead: jest.fn(),
    onScheduleFired: jest.fn(),
    onSessionStatusChanged: jest.fn(),
    onSessionListEvent: jest.fn(),
    onQuickAssistantRenamed: jest.fn(),
    onModelConfigUpdated: jest.fn(),
    onRemoteAgentsChanged: jest.fn(),
    onRemoteAgentSessionEvent: jest.fn(),
    onAgentChanged: jest.fn(),
    onReauthRequired: jest.fn(),
  };
}

describe("dispatchGlobalEvent", () => {
  it.each([
    [IM_WS_EVENTS.message, "onMessage"],
    [IM_WS_EVENTS.presence, "onPresence"],
    [IM_WS_EVENTS.conversationCreated, "onConversationCreated"],
    [IM_WS_EVENTS.conversationRemoved, "onConversationRemoved"],
    [IM_WS_EVENTS.conversationRead, "onConversationRead"],
    [SCHEDULE_EVENTS.fired, "onScheduleFired"],
    [SESSION_STATUS_EVENTS.changed, "onSessionStatusChanged"],
    [QUICK_ASSISTANT_EVENTS.renamed, "onQuickAssistantRenamed"],
    [AUTH_WS_EVENTS.reauthRequired, "onReauthRequired"],
  ])("%s → %s", (type, handlerKey) => {
    const h = makeHandlers();
    const payload = { x: 1 };
    dispatchGlobalEvent({ type, payload, ts: 1 }, h);
    expect(h[handlerKey as keyof typeof h]).toHaveBeenCalledWith(payload);
  });

  it("model-config.updated → onModelConfigUpdated（无参失效信号）", () => {
    const h = makeHandlers();
    dispatchGlobalEvent(
      { type: MODEL_CONFIG_EVENTS.updated, payload: {}, ts: 1 },
      h,
    );
    expect(h.onModelConfigUpdated).toHaveBeenCalled();
  });

  it("remote-agent.registry_changed → onRemoteAgentsChanged（无参失效信号）", () => {
    const h = makeHandlers();
    dispatchGlobalEvent(
      {
        type: REMOTE_AGENT_EVENTS.registryChanged,
        payload: { cloudUserId: "U1" },
        ts: 1,
      },
      h,
    );
    expect(h.onRemoteAgentsChanged).toHaveBeenCalled();
    // 失效信号：不误派给别的 handler
    expect(h.onModelConfigUpdated).not.toHaveBeenCalled();
  });

  it("dispatchGlobalEvent 分发 remote-agent.session_event 到 onRemoteAgentSessionEvent", () => {
    const h = makeHandlers();
    dispatchGlobalEvent(
      {
        type: REMOTE_AGENT_EVENTS.sessionEvent,
        ts: 1,
        payload: {
          agentId: "cloud-a1",
          event: SESSION_LIFECYCLE_EVENTS.created,
          payload: { agentId: "local-a1", session: { id: "s9" } },
        },
      },
      h,
    );
    expect(h.onRemoteAgentSessionEvent).toHaveBeenCalledWith({
      agentId: "cloud-a1",
      event: SESSION_LIFECYCLE_EVENTS.created,
      payload: expect.anything(),
    });
    // 专属信封：不误派给本机会话生命周期的 handler（分流规则互斥，见
    // REMOTE_AGENT_EVENTS.sessionEvent 的 JSDoc）
    expect(h.onSessionListEvent).not.toHaveBeenCalled();
  });

  it("既有 3 个 handler 仍各自生效（不被覆盖）", () => {
    const h = makeHandlers();
    dispatchGlobalEvent(
      {
        type: SESSION_STATUS_EVENTS.changed,
        ts: 1,
        payload: { agentId: "a", sessionId: "s", status: "idle" },
      },
      h,
    );
    dispatchGlobalEvent(
      { type: REMOTE_AGENT_EVENTS.registryChanged, ts: 1, payload: {} },
      h,
    );
    dispatchGlobalEvent({ type: AGENT_EVENTS.changed, ts: 1, payload: {} }, h);
    expect(h.onSessionStatusChanged).toHaveBeenCalled();
    expect(h.onRemoteAgentsChanged).toHaveBeenCalled();
    expect(h.onAgentChanged).toHaveBeenCalled();
  });

  it("agent.changed → onAgentChanged（无参失效信号）", () => {
    const h = makeHandlers();
    dispatchGlobalEvent(
      {
        type: AGENT_EVENTS.changed,
        payload: { cloudUserId: "U1", agentId: "a1" },
        ts: 1,
      },
      h,
    );
    expect(h.onAgentChanged).toHaveBeenCalled();
    // 失效信号：不误派给邻近的远程 Agent handler（两者语义不同、缓存键不同）
    expect(h.onRemoteAgentsChanged).not.toHaveBeenCalled();
  });

  it("未知 type → 不抛错、不调用任何 handler", () => {
    const h = makeHandlers();
    dispatchGlobalEvent({ type: "x.unknown", payload: {}, ts: 1 }, h);
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });

  describe("会话生命周期事件（created/deleted/renamed 共用 onSessionListEvent）", () => {
    const session = {
      id: "s1",
      title: "新会话",
      status: "running" as const,
      pinned: false,
      pinnedAt: null,
      titleGenerated: false,
      modelConfigId: null,
      agentId: "a1",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    };

    it("session.created → onSessionListEvent（归一为 SessionListEvent）", () => {
      const h = makeHandlers();
      dispatchGlobalEvent(
        {
          type: SESSION_LIFECYCLE_EVENTS.created,
          payload: { agentId: "a1", session },
          ts: 1,
        },
        h,
      );
      expect(h.onSessionListEvent).toHaveBeenCalledWith({
        type: "created",
        session,
      });
    });

    it("session.deleted → onSessionListEvent（归一为 SessionListEvent）", () => {
      const h = makeHandlers();
      dispatchGlobalEvent(
        {
          type: SESSION_LIFECYCLE_EVENTS.deleted,
          payload: { agentId: "a1", sessionId: "s1" },
          ts: 1,
        },
        h,
      );
      expect(h.onSessionListEvent).toHaveBeenCalledWith({
        type: "deleted",
        sessionId: "s1",
      });
    });

    it("session.renamed → onSessionListEvent（归一为 SessionListEvent）", () => {
      const h = makeHandlers();
      dispatchGlobalEvent(
        {
          type: SESSION_LIFECYCLE_EVENTS.renamed,
          payload: { agentId: "a1", sessionId: "s1", title: "新标题" },
          ts: 1,
        },
        h,
      );
      expect(h.onSessionListEvent).toHaveBeenCalledWith({
        type: "renamed",
        sessionId: "s1",
        title: "新标题",
      });
    });

    it("payload 形状不符（畸形帧）→ toSessionListEvent 返 null，不调用 onSessionListEvent、不抛错", () => {
      const h = makeHandlers();
      expect(() =>
        dispatchGlobalEvent(
          {
            type: SESSION_LIFECYCLE_EVENTS.created,
            payload: { bogus: true },
            ts: 1,
          },
          h,
        ),
      ).not.toThrow();
      expect(h.onSessionListEvent).not.toHaveBeenCalled();
    });
  });
});

/**
 * 执行 hook 并跑其 useEffect，返回捕获到的 socket 监听表 + invalidate spy。
 * 供下方两个 describe 块（远程 Agent 列表接线 / 缺陷 1 接线）共用。
 *
 * `opts.activeSession`/`opts.selfDeletingIds` 对应 use-global-events.ts 里
 * 按顺序调用的两次 `useAtomValue`（activeAssistantSessionAtom →
 * selfDeletingSessionIdsAtom，见该文件"缺陷 1"注释块），`mockReturnValueOnce`
 * 链式配置——不认 atom 参数身份，只认调用顺序。
 */
function runHook(
  connected = false,
  opts?: {
    activeSession?: { id: string; remoteAgentId: string | null } | null;
    selfDeletingIds?: ReadonlySet<string>;
  },
) {
  const listeners: Record<string, (arg?: unknown) => void> = {};
  const socket = {
    connected,
    on: jest.fn((ev: string, fn: (arg?: unknown) => void) => {
      listeners[ev] = fn;
    }),
    off: jest.fn(),
  };
  (getEventsSocket as jest.Mock).mockReturnValue(socket);
  const invalidateQueries = jest.fn();
  (useQueryClient as jest.Mock).mockReturnValue({ invalidateQueries });
  const push = jest.fn();
  (useRouter as jest.Mock).mockReturnValue({ push });
  (useTranslations as jest.Mock).mockReturnValue((key: string) => key);
  (useAtomValue as jest.Mock)
    .mockReturnValueOnce(opts?.activeSession ?? null)
    .mockReturnValueOnce(opts?.selfDeletingIds ?? new Set());
  (useEffect as jest.Mock).mockImplementation((fn: () => void) => {
    fn();
  });

  // react 的 useEffect 已被 mock 成同步执行，此处只是普通函数调用，无真实 React 渲染
  // biome-ignore lint/correctness/useHookAtTopLevel: 单测非组件渲染环境，见上
  useGlobalEvents();
  return { listeners, invalidateQueries, socket, push };
}

/**
 * useGlobalEvents 的副作用接线：跑 useEffect 捕获到的回调，拿到真实注册的
 * socket 监听器，断言「收到注册表变更事件」与「socket 重连」两条路径都会
 * invalidate 远程 Agent 列表。
 */
describe("useGlobalEvents 远程 Agent 列表接线", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // testEnvironment 是 node（本文件历来如此），没有全局 window；缺陷 1 的
    // 提示走 window.alert，按需补一个最小桩（这个 describe 块不触发它，但
    // runHook 是共用的，统一在这里桩，避免两处重复）。
    (globalThis as unknown as { window: { alert: jest.Mock } }).window = {
      alert: jest.fn(),
    };
  });

  it("收到 remote-agent.registry_changed → invalidate remoteAgentsQueryKey", () => {
    const { listeners, invalidateQueries } = runHook();

    listeners.event?.({
      type: REMOTE_AGENT_EVENTS.registryChanged,
      payload: { cloudUserId: "U1" },
      ts: 1,
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: remoteAgentsQueryKey,
    });
  });

  it("socket 重连 → 补拉远程 Agent 列表（兜住离线期间的变更 + 云端广播盲区）", () => {
    const { listeners, invalidateQueries } = runHook();

    listeners.connect?.();

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: remoteAgentsQueryKey,
    });
    // 模型列表的原有补拉不能被挤掉
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["model-configs"],
    });
  });

  it("挂载时 socket 已连着 → 立即补拉一次（错过 connect 事件的时序洞）", () => {
    const { invalidateQueries } = runHook(true);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: remoteAgentsQueryKey,
    });
  });

  it("收到 agent.changed → invalidate agentsQueryKey（侧栏 Agent 行 + 会话标题栏跟着改名刷新）", () => {
    const { listeners, invalidateQueries } = runHook();

    listeners.event?.({
      type: AGENT_EVENTS.changed,
      payload: { cloudUserId: "U1", agentId: "a1" },
      ts: 1,
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: agentsQueryKey,
    });
  });

  it("socket 重连 → 补拉本地 Agent 列表（兜住断线期间 rename_agent 工具改名丢事件）", () => {
    const { listeners, invalidateQueries } = runHook();

    listeners.connect?.();

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: agentsQueryKey,
    });
    // 原有两条补拉不能被挤掉
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: remoteAgentsQueryKey,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["model-configs"],
    });
  });
});

/**
 * 缺陷 1（删除会话后主内容区不跟随）的接线测试：`isActiveSessionDeletedByEvent`
 * 本身的判定逻辑已在 `session-deleted-elsewhere.spec.ts` 独立、详尽地覆盖
 * （本机/远程 scope、自删宽限、agentId 不匹配等边界）；这里只验证
 * `useGlobalEvents` 的两个事件 handler（`onSessionListEvent`/
 * `onRemoteAgentSessionEvent`）确实把正确的 scope/active/selfDeletingIds 接
 * 进了那个判定函数，并在命中时真的触发 `window.alert` + `router.push`——
 * 即“本机路径”与“远程路径”都有测试真实走过 `useGlobalEvents` 的完整分发
 * 链路，不是只测了被抽出来的纯函数。
 */
describe("useGlobalEvents 缺陷 1 接线：当前会话被删除 → alert + 跳回起手台", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // testEnvironment 是 node，没有全局 window；这里的断言直接读 window.alert，
    // 必须每个 describe 块各自桩一次（beforeEach 不跨 describe 共享）。
    (globalThis as unknown as { window: { alert: jest.Mock } }).window = {
      alert: jest.fn(),
    };
  });

  function alertMock(): jest.Mock {
    return (globalThis as unknown as { window: { alert: jest.Mock } }).window
      .alert;
  }

  describe("本机路径（sessionsAtom + SESSION_LIFECYCLE_EVENTS.deleted）", () => {
    it("当前打开的本机会话被删除（非自删）→ alert + 跳回 /assistant", () => {
      const { listeners, push } = runHook(false, {
        activeSession: { id: "s1", remoteAgentId: null },
      });

      listeners.event?.({
        type: SESSION_LIFECYCLE_EVENTS.deleted,
        payload: { agentId: "a1", sessionId: "s1" },
        ts: 1,
      });

      expect(alertMock()).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith("/assistant");
    });

    it("删除的不是当前打开的会话 → 不提示、不跳转", () => {
      const { listeners, push } = runHook(false, {
        activeSession: { id: "s1", remoteAgentId: null },
      });

      listeners.event?.({
        type: SESSION_LIFECYCLE_EVENTS.deleted,
        payload: { agentId: "a1", sessionId: "别的会话" },
        ts: 1,
      });

      expect(alertMock()).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });

    it("本设备自己删除（在宽限集合里）→ 不重复提示（ws 回声与自身操作不冲突）", () => {
      const { listeners, push } = runHook(false, {
        activeSession: { id: "s1", remoteAgentId: null },
        selfDeletingIds: new Set(["s1"]),
      });

      listeners.event?.({
        type: SESSION_LIFECYCLE_EVENTS.deleted,
        payload: { agentId: "a1", sessionId: "s1" },
        ts: 1,
      });

      expect(alertMock()).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });

    it("session.created/renamed 事件（非 deleted）→ 不触发提示/跳转（只更新列表）", () => {
      const { listeners, push } = runHook(false, {
        activeSession: { id: "s1", remoteAgentId: null },
      });

      listeners.event?.({
        type: SESSION_LIFECYCLE_EVENTS.renamed,
        payload: { agentId: "a1", sessionId: "s1", title: "新标题" },
        ts: 1,
      });

      expect(alertMock()).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });
  });

  describe("远程路径（remoteSessionsAtom + REMOTE_AGENT_EVENTS.sessionEvent）", () => {
    it("当前打开的远程会话被宿主设备删除 → alert + 跳回 /assistant", () => {
      const { listeners, push } = runHook(false, {
        activeSession: { id: "rs1", remoteAgentId: "cloud-a1" },
      });

      listeners.event?.({
        type: REMOTE_AGENT_EVENTS.sessionEvent,
        payload: {
          agentId: "cloud-a1",
          event: SESSION_LIFECYCLE_EVENTS.deleted,
          payload: { agentId: "local-a1", sessionId: "rs1" },
        },
        ts: 1,
      });

      expect(alertMock()).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith("/assistant");
    });

    it("别的远程 Agent 的会话被删（agentId 不匹配当前打开的）→ 不误报", () => {
      const { listeners, push } = runHook(false, {
        activeSession: { id: "rs1", remoteAgentId: "cloud-a1" },
      });

      listeners.event?.({
        type: REMOTE_AGENT_EVENTS.sessionEvent,
        payload: {
          agentId: "cloud-a2",
          event: SESSION_LIFECYCLE_EVENTS.deleted,
          payload: { agentId: "local-a1", sessionId: "rs1" },
        },
        ts: 1,
      });

      expect(alertMock()).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });

    it("当前打开的其实是本机会话（remoteAgentId 为 null）→ 远程镜像事件不误报", () => {
      const { listeners, push } = runHook(false, {
        activeSession: { id: "s1", remoteAgentId: null },
      });

      listeners.event?.({
        type: REMOTE_AGENT_EVENTS.sessionEvent,
        payload: {
          agentId: "cloud-a1",
          event: SESSION_LIFECYCLE_EVENTS.deleted,
          payload: { agentId: "local-a1", sessionId: "s1" },
        },
        ts: 1,
      });

      expect(alertMock()).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });

    it("远程会话没有自删抑制：即使 sessionId 恰好落在本机 selfDeletingIds 里也照常提示", () => {
      const { listeners, push } = runHook(false, {
        activeSession: { id: "rs1", remoteAgentId: "cloud-a1" },
        selfDeletingIds: new Set(["rs1"]),
      });

      listeners.event?.({
        type: REMOTE_AGENT_EVENTS.sessionEvent,
        payload: {
          agentId: "cloud-a1",
          event: SESSION_LIFECYCLE_EVENTS.deleted,
          payload: { agentId: "local-a1", sessionId: "rs1" },
        },
        ts: 1,
      });

      expect(alertMock()).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith("/assistant");
    });
  });
});
