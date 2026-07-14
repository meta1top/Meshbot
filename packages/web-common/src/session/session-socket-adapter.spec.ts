import { createSessionSocketAdapter } from "./session-socket-adapter";
import type { SessionRunEvents, SessionTransport } from "./transport";

/** 造一个最小假 transport：只实现 subscribe()，其余方法本测试不需要。 */
function makeTransport(): SessionTransport & {
  emitFrame: (event: string, payload: unknown) => void;
  currentEvents: () => SessionRunEvents | null;
} {
  let current: SessionRunEvents | null = null;
  return {
    capabilities: { localRun: false },
    listSessions: async () => [],
    fetchHistory: async () => {
      throw new Error("not used");
    },
    startRun: async () => ({ streamId: null }),
    interrupt: async () => {},
    confirm: async () => {},
    answer: async () => {},
    patchSessionModel: async () => {},
    fetchPending: async () => {
      throw new Error("not used");
    },
    fetchActiveRun: async () => null,
    readArtifact: async () => {
      throw new Error("not used");
    },
    uploadArtifactToDrive: async () => {
      throw new Error("not used");
    },
    subscribe(events) {
      current = events;
      return () => {
        if (current === events) current = null;
      };
    },
    emitFrame(event, payload) {
      current?.onEvent(event, payload);
    },
    currentEvents: () => current,
  };
}

describe("createSessionSocketAdapter", () => {
  it("connected 恒为 true", () => {
    const adapter = createSessionSocketAdapter(makeTransport());
    expect(adapter.connected).toBe(true);
  });

  it("emit 为 no-op，不抛错、不触碰 transport", () => {
    const transport = makeTransport();
    const adapter = createSessionSocketAdapter(transport);
    expect(() =>
      adapter.emit("run.subscribe", { sessionId: "s1" }),
    ).not.toThrow();
    // 未调用 on() 前不应订阅
    expect(transport.currentEvents()).toBeNull();
  });

  it("首次 on() 才惰性调用 transport.subscribe()", () => {
    const transport = makeTransport();
    const adapter = createSessionSocketAdapter(transport);
    expect(transport.currentEvents()).toBeNull();
    adapter.on("run.chunk", () => {});
    expect(transport.currentEvents()).not.toBeNull();
  });

  it("按事件名分发给对应 listener，不同事件名互不干扰", () => {
    const transport = makeTransport();
    const adapter = createSessionSocketAdapter(transport);
    const chunkCalls: unknown[] = [];
    const doneCalls: unknown[] = [];
    adapter.on("run.chunk", (p) => chunkCalls.push(p));
    adapter.on("run.done", (p) => doneCalls.push(p));
    transport.emitFrame("run.chunk", { delta: "a" });
    expect(chunkCalls).toEqual([{ delta: "a" }]);
    expect(doneCalls).toEqual([]);
  });

  it("同一事件名支持多个 listener，全部收到", () => {
    const transport = makeTransport();
    const adapter = createSessionSocketAdapter(transport);
    const a: unknown[] = [];
    const b: unknown[] = [];
    adapter.on("run.chunk", (p) => a.push(p));
    adapter.on("run.chunk", (p) => b.push(p));
    transport.emitFrame("run.chunk", { delta: "x" });
    expect(a).toEqual([{ delta: "x" }]);
    expect(b).toEqual([{ delta: "x" }]);
  });

  it("off() 后该 listener 不再收到事件，其余 listener 不受影响", () => {
    const transport = makeTransport();
    const adapter = createSessionSocketAdapter(transport);
    const a: unknown[] = [];
    const b: unknown[] = [];
    const listenerA = (p: unknown) => a.push(p);
    adapter.on("run.chunk", listenerA);
    adapter.on("run.chunk", (p) => b.push(p));
    adapter.off("run.chunk", listenerA);
    transport.emitFrame("run.chunk", { delta: "y" });
    expect(a).toEqual([]);
    expect(b).toEqual([{ delta: "y" }]);
  });

  it("未知事件名（无 listener 注册）静默丢弃，不抛错", () => {
    const transport = makeTransport();
    const adapter = createSessionSocketAdapter(transport);
    adapter.on("run.chunk", () => {});
    expect(() => transport.emitFrame("run.usage", { x: 1 })).not.toThrow();
  });

  it("listener 内同步 off 自身不影响本次分发的其余 listener", () => {
    const transport = makeTransport();
    const adapter = createSessionSocketAdapter(transport);
    const order: string[] = [];
    const selfOff = (_p: unknown) => {
      order.push("self");
      adapter.off("run.chunk", selfOff);
    };
    const other = (_p: unknown) => order.push("other");
    adapter.on("run.chunk", selfOff);
    adapter.on("run.chunk", other);
    transport.emitFrame("run.chunk", {});
    expect(order).toEqual(["self", "other"]);
    // 第二次分发：selfOff 已 off，只剩 other
    transport.emitFrame("run.chunk", {});
    expect(order).toEqual(["self", "other", "other"]);
  });

  it("多次 on() 只订阅一次 transport（subscribe 只被调用一次）", () => {
    const transport = makeTransport();
    let subscribeCalls = 0;
    const originalSubscribe = transport.subscribe.bind(transport);
    transport.subscribe = (events) => {
      subscribeCalls += 1;
      return originalSubscribe(events);
    };
    const adapter = createSessionSocketAdapter(transport);
    adapter.on("run.chunk", () => {});
    adapter.on("run.done", () => {});
    adapter.on("run.error", () => {});
    expect(subscribeCalls).toBe(1);
  });
});
