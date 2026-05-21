import { EventEmitter2 } from "@nestjs/event-emitter";
import type { PendingMessage } from "../entities/pending-message.entity";
import { RunnerService } from "./runner.service";

/** 内存版 SessionService 替身。 */
function fakeSessionService() {
  const store: PendingMessage[] = [];
  let seq = 0;
  return {
    store,
    async claimPending(sessionId: string) {
      const rows = store.filter(
        (m) => m.sessionId === sessionId && m.status === "pending",
      );
      for (const r of rows) r.status = "processing";
      return rows;
    },
    async markProcessed(ids: string[]) {
      for (const m of store) if (ids.includes(m.id)) m.status = "processed";
    },
    async rollbackToPending(ids: string[]) {
      for (const m of store) if (ids.includes(m.id)) m.status = "pending";
    },
    async setStatus() {},
    enqueue(sessionId: string, content: string) {
      store.push({
        id: `m${seq++}`,
        sessionId,
        content,
        status: "pending",
        createdAt: new Date(),
        processedAt: null,
      });
    },
  };
}

/** 产出固定 chunk 流的 GraphService 替身。 */
function fakeGraphService(opts?: { throwErr?: boolean }) {
  return {
    async *streamMessage() {
      if (opts?.throwErr) throw new Error("llm boom");
      yield { messageId: "msg-1", delta: "你" };
      yield { messageId: "msg-1", delta: "好" };
    },
  };
}

describe("RunnerService", () => {
  it("kick：消费 pending → 发 run.chunk/run.done → 消息转 processed", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const events: { name: string; payload: unknown }[] = [];
    emitter.onAny((name, payload) =>
      events.push({ name: String(name), payload }),
    );
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
    );
    await runner.kickAndWait("s1");
    expect(events.map((e) => e.name)).toEqual([
      "run.chunk",
      "run.chunk",
      "run.done",
    ]);
    expect(sess.store.every((m) => m.status === "processed")).toBe(true);
  });

  it("kick：run 期间新入队的消息，结束后自动续跑", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    let chunkCount = 0;
    emitter.on("run.chunk", () => {
      chunkCount++;
      if (chunkCount === 1) sess.enqueue("s1", "second");
    });
    sess.enqueue("s1", "first");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
    );
    await runner.kickAndWait("s1");
    expect(sess.store).toHaveLength(2);
    expect(sess.store.every((m) => m.status === "processed")).toBe(true);
  });

  it("出错时发 run.error 并把消息退回 pending", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const errs: unknown[] = [];
    emitter.on("run.error", (p) => errs.push(p));
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService({ throwErr: true }) as never,
      emitter,
    );
    await runner.kickAndWait("s1");
    expect(errs).toHaveLength(1);
    expect(sess.store[0].status).toBe("pending");
  });

  it("getInflight：run 进行中可取到累加快照", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    sess.enqueue("s1", "hi");
    let snapshotDuringRun: unknown = null;
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
    );
    emitter.on("run.chunk", () => {
      snapshotDuringRun = runner.getInflight("s1");
    });
    await runner.kickAndWait("s1");
    expect(snapshotDuringRun).not.toBeNull();
    expect(runner.getInflight("s1")).toBeNull();
  });
});
