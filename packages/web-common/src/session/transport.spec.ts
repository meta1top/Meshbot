import { FrameSequencer, MulticastRunEvents } from "./transport";

describe("FrameSequencer", () => {
  let sequencer: FrameSequencer;

  beforeEach(() => {
    sequencer = new FrameSequencer();
  });

  it("should emit frames in order immediately when they arrive sequentially", () => {
    const results: Array<{ event: string; payload: unknown }> = [];

    const frame1 = sequencer.push({
      seq: 1,
      event: "run.chunk",
      payload: "hello",
    });
    results.push(...frame1);

    const frame2 = sequencer.push({
      seq: 2,
      event: "run.chunk",
      payload: " world",
    });
    results.push(...frame2);

    const frame3 = sequencer.push({ seq: 3, event: "run.done", payload: null });
    results.push(...frame3);

    expect(results).toEqual([
      { event: "run.chunk", payload: "hello" },
      { event: "run.chunk", payload: " world" },
      { event: "run.done", payload: null },
    ]);
  });

  it("should buffer out-of-order frames and emit them in sequence when gap is filled", () => {
    const results: Array<{ event: string; payload: unknown }> = [];

    // Push seq=2 first (out of order)
    const frame2 = sequencer.push({
      seq: 2,
      event: "run.chunk",
      payload: "world",
    });
    results.push(...frame2);

    // Should not emit yet
    expect(results).toHaveLength(0);

    // Push seq=3
    const frame3 = sequencer.push({ seq: 3, event: "run.done", payload: null });
    results.push(...frame3);

    // Still nothing (waiting for seq=1)
    expect(results).toHaveLength(0);

    // Push seq=1 (fill the gap)
    const frame1 = sequencer.push({
      seq: 1,
      event: "run.chunk",
      payload: "hello",
    });
    results.push(...frame1);

    // Now all three should be emitted in order
    expect(results).toEqual([
      { event: "run.chunk", payload: "hello" },
      { event: "run.chunk", payload: "world" },
      { event: "run.done", payload: null },
    ]);
  });

  it("should reset buffer and internal state on reset()", () => {
    const results: Array<{ event: string; payload: unknown }> = [];

    // Push out of order
    sequencer.push({ seq: 2, event: "run.chunk", payload: "buffered" });
    sequencer.reset();

    // After reset, expect internal counter to be reset
    const frame1 = sequencer.push({
      seq: 1,
      event: "run.chunk",
      payload: "after reset",
    });
    results.push(...frame1);

    // Should emit immediately (seq=1 is expected after reset)
    expect(results).toEqual([{ event: "run.chunk", payload: "after reset" }]);
  });

  it("should discard duplicate seq frames silently", () => {
    const results: Array<{ event: string; payload: unknown }> = [];

    const frame1 = sequencer.push({
      seq: 1,
      event: "run.chunk",
      payload: "first",
    });
    results.push(...frame1);

    expect(results).toHaveLength(1);

    // Push same seq=1 again
    const frameDup = sequencer.push({
      seq: 1,
      event: "run.chunk",
      payload: "duplicate",
    });
    results.push(...frameDup);

    // Should be silently discarded (no new events)
    expect(results).toHaveLength(1);

    // Normal sequence should continue
    const frame2 = sequencer.push({ seq: 2, event: "run.done", payload: null });
    results.push(...frame2);

    expect(results).toEqual([
      { event: "run.chunk", payload: "first" },
      { event: "run.done", payload: null },
    ]);
  });
});

describe("MulticastRunEvents", () => {
  it("单一订阅者收到广播事件", () => {
    const bus = new MulticastRunEvents();
    const received: unknown[] = [];
    bus.subscribe({
      onEvent: (event, payload) => received.push({ event, payload }),
    });
    bus.emit("run.chunk", { delta: "a" });
    expect(received).toEqual([{ event: "run.chunk", payload: { delta: "a" } }]);
  });

  it("双订阅者同帧都收到（修复单 current 指针漏洞的核心断言）", () => {
    const bus = new MulticastRunEvents();
    const a: unknown[] = [];
    const b: unknown[] = [];
    bus.subscribe({ onEvent: (event, payload) => a.push({ event, payload }) });
    bus.subscribe({ onEvent: (event, payload) => b.push({ event, payload }) });
    bus.emit("run.done", { messageId: "m1" });
    expect(a).toEqual([{ event: "run.done", payload: { messageId: "m1" } }]);
    expect(b).toEqual([{ event: "run.done", payload: { messageId: "m1" } }]);
  });

  it("退订一方不影响另一方继续收帧", () => {
    const bus = new MulticastRunEvents();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = bus.subscribe({
      onEvent: (event, payload) => a.push({ event, payload }),
    });
    bus.subscribe({ onEvent: (event, payload) => b.push({ event, payload }) });
    unsubA();
    bus.emit("run.chunk", { delta: "x" });
    expect(a).toEqual([]);
    expect(b).toEqual([{ event: "run.chunk", payload: { delta: "x" } }]);
  });

  it("size 反映当前订阅者数量，退订后递减", () => {
    const bus = new MulticastRunEvents();
    expect(bus.size).toBe(0);
    const unsub1 = bus.subscribe({ onEvent: () => {} });
    bus.subscribe({ onEvent: () => {} });
    expect(bus.size).toBe(2);
    unsub1();
    expect(bus.size).toBe(1);
  });

  it("同一订阅者重复退订是幂等的，不影响其余订阅者", () => {
    const bus = new MulticastRunEvents();
    const a: unknown[] = [];
    const unsubA = bus.subscribe({
      onEvent: (event, payload) => a.push({ event, payload }),
    });
    unsubA();
    expect(() => unsubA()).not.toThrow();
    bus.emit("run.chunk", {});
    expect(a).toEqual([]);
  });

  it("reset 清空全部订阅者", () => {
    const bus = new MulticastRunEvents();
    const a: unknown[] = [];
    bus.subscribe({ onEvent: (event, payload) => a.push({ event, payload }) });
    bus.reset();
    expect(bus.size).toBe(0);
    bus.emit("run.chunk", {});
    expect(a).toEqual([]);
  });

  it("订阅者回调内同步退订自身不影响本次广播的其余订阅者", () => {
    const bus = new MulticastRunEvents();
    const order: string[] = [];
    const self = {
      onEvent: (_event: string, _payload: unknown) => {
        order.push("self");
        unsubSelf();
      },
    };
    const unsubSelf = bus.subscribe(self);
    bus.subscribe({ onEvent: () => order.push("other") });
    bus.emit("run.chunk", {});
    expect(order).toEqual(["self", "other"]);
    bus.emit("run.chunk", {});
    expect(order).toEqual(["self", "other", "other"]);
  });
});
