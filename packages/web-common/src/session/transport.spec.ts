import { FrameSequencer } from "./transport";

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
