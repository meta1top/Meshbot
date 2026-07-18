// mock atoms/hooks dependencies（纯函数测试不需要真实 jotai/react/socket）
jest.mock("@/atoms/im", () => ({}));
jest.mock("@/atoms/schedule-activity", () => ({}));
jest.mock("@/atoms/sessions", () => ({}));
jest.mock("@/atoms/devices", () => ({}));
jest.mock("@/atoms/assistant-panel", () => ({}));
jest.mock("@meshbot/web-common", () => ({ clearAccessToken: jest.fn() }));
jest.mock("@/rest/remote-agents", () => ({
  remoteAgentsQueryKey: ["remote-agents"],
}));
jest.mock("@/lib/events-socket", () => ({ getEventsSocket: jest.fn() }));
jest.mock("jotai", () => ({ useSetAtom: jest.fn() }));
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  useEffect: jest.fn(),
}));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: jest.fn() }));

import { AUTH_WS_EVENTS, IM_WS_EVENTS } from "@meshbot/types";
import {
  MODEL_CONFIG_EVENTS,
  QUICK_ASSISTANT_EVENTS,
  REMOTE_AGENT_EVENTS,
  SCHEDULE_EVENTS,
  SESSION_STATUS_EVENTS,
} from "@meshbot/types-agent";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { getEventsSocket } from "@/lib/events-socket";
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
    onQuickAssistantRenamed: jest.fn(),
    onModelConfigUpdated: jest.fn(),
    onRemoteAgentsChanged: jest.fn(),
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

  it("未知 type → 不抛错、不调用任何 handler", () => {
    const h = makeHandlers();
    dispatchGlobalEvent({ type: "x.unknown", payload: {}, ts: 1 }, h);
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });
});

/**
 * useGlobalEvents 的副作用接线：跑 useEffect 捕获到的回调，拿到真实注册的
 * socket 监听器，断言「收到注册表变更事件」与「socket 重连」两条路径都会
 * invalidate 远程 Agent 列表。
 */
describe("useGlobalEvents 远程 Agent 列表接线", () => {
  /** 执行 hook 并跑其 useEffect，返回捕获到的 socket 监听表 + invalidate spy。 */
  function runHook(connected = false) {
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
    (useEffect as jest.Mock).mockImplementation((fn: () => void) => {
      fn();
    });

    // react 的 useEffect 已被 mock 成同步执行，此处只是普通函数调用，无真实 React 渲染
    // biome-ignore lint/correctness/useHookAtTopLevel: 单测非组件渲染环境，见上
    useGlobalEvents();
    return { listeners, invalidateQueries, socket };
  }

  beforeEach(() => jest.clearAllMocks());

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
});
