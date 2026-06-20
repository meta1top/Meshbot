// mock atoms/hooks dependencies（纯函数测试不需要真实 jotai/react/socket）
jest.mock("@/atoms/im", () => ({}));
jest.mock("@/atoms/schedule-activity", () => ({}));
jest.mock("@/lib/events-socket", () => ({}));
jest.mock("jotai", () => ({ useSetAtom: jest.fn() }));
jest.mock("react", () => ({ useEffect: jest.fn() }));

import { IM_WS_EVENTS } from "@meshbot/types";
import { SCHEDULE_EVENTS } from "@meshbot/types-agent";
import { dispatchGlobalEvent } from "./use-global-events";

function makeHandlers() {
  return {
    onMessage: jest.fn(),
    onPresence: jest.fn(),
    onConversationCreated: jest.fn(),
    onConversationRemoved: jest.fn(),
    onConversationRead: jest.fn(),
    onScheduleFired: jest.fn(),
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
  ])("%s → %s", (type, handlerKey) => {
    const h = makeHandlers();
    const payload = { x: 1 };
    dispatchGlobalEvent({ type, payload, ts: 1 }, h);
    expect(h[handlerKey as keyof typeof h]).toHaveBeenCalledWith(payload);
  });

  it("未知 type → 不抛错、不调用任何 handler", () => {
    const h = makeHandlers();
    dispatchGlobalEvent({ type: "x.unknown", payload: {}, ts: 1 }, h);
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });
});
