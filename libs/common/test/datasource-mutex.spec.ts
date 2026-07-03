import type { DataSource } from "typeorm";
import { runExclusive } from "../src/typeorm/datasource-mutex";

/** 造一个仅用作 WeakMap key 的假 DataSource，不需要真实连接。 */
function fakeDataSource(): DataSource {
  return {} as unknown as DataSource;
}

describe("runExclusive（按 DataSource 的 FIFO 互斥锁）", () => {
  it("同一 DataSource 上的任务严格串行（不重叠）+ 按提交顺序 FIFO", async () => {
    const ds = fakeDataSource();
    const events: string[] = [];

    const makeTask = (name: string, delayMs: number) => () =>
      runExclusive(ds, async () => {
        events.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, delayMs));
        events.push(`${name}:end`);
        return name;
      });

    // 先提交的任务延迟更长，若不是严格串行 + FIFO，短任务会插队在其 end 之前开始。
    const results = await Promise.all([
      makeTask("a", 30)(),
      makeTask("b", 5)(),
      makeTask("c", 5)(),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual([
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  it("不同 DataSource 互不阻塞，可真正并发执行", async () => {
    const dsA = fakeDataSource();
    const dsB = fakeDataSource();
    const events: string[] = [];

    const taskA = runExclusive(dsA, async () => {
      events.push("A:start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("A:end");
    });
    const taskB = runExclusive(dsB, async () => {
      events.push("B:start");
      await new Promise((r) => setTimeout(r, 5));
      events.push("B:end");
    });

    await Promise.all([taskA, taskB]);

    // B 应在 A 结束前就已经开始并结束（否则说明被 A 阻塞，串行化误伤了不同 DataSource）。
    expect(events.indexOf("B:end")).toBeLessThan(events.indexOf("A:end"));
    expect(events.indexOf("B:start")).toBeLessThan(events.indexOf("A:end"));
  });

  it("某个任务 reject 不会阻断队列，后续排队任务仍正常执行", async () => {
    const ds = fakeDataSource();
    const failing = runExclusive(ds, async () => {
      throw new Error("boom");
    });
    const following = runExclusive(ds, async () => "ok");

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBe("ok");
  });
});
