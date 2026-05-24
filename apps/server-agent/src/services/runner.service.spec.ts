import { EventEmitter2 } from "@nestjs/event-emitter";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
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
    async markFailed(ids: string[]) {
      for (const m of store) if (ids.includes(m.id)) m.status = "failed";
    },
    async claimFailed(sessionId: string) {
      const rows = store.filter(
        (m) => m.sessionId === sessionId && m.status === "failed",
      );
      for (const r of rows) r.status = "processing";
      return rows;
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

/** 产出固定 chunk 流（含 usage 事件）的 GraphService 替身。 */
function fakeGraphService(opts?: { throwErr?: boolean }) {
  return {
    async *streamMessage() {
      if (opts?.throwErr) throw new Error("llm boom");
      yield { kind: "chunk", messageId: "msg-1", delta: "你" };
      yield { kind: "chunk", messageId: "msg-1", delta: "好" };
      yield {
        kind: "assistant_done",
        messageId: "msg-1",
        content: "你好",
        reasoning: "",
        toolCalls: null,
      };
      yield {
        kind: "usage",
        messageId: "msg-1",
        providerType: "deepseek",
        model: "deepseek-chat",
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheReadTokens: 3,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        durationMs: 100,
      };
    },
    async *resumeStream() {
      if (opts?.throwErr) throw new Error("llm boom");
      yield { kind: "chunk", messageId: "msg-r", delta: "重" };
      yield { kind: "chunk", messageId: "msg-r", delta: "试" };
      yield {
        kind: "assistant_done",
        messageId: "msg-r",
        content: "重试",
        reasoning: "",
        toolCalls: null,
      };
      yield {
        kind: "usage",
        messageId: "msg-r",
        providerType: "deepseek",
        model: "deepseek-chat",
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        durationMs: 80,
      };
    },
  };
}

/** 内存版 LlmCallService 替身。 */
function fakeLlmCallService() {
  const records: unknown[] = [];
  return {
    records,
    async record(input: unknown) {
      records.push(input);
    },
  };
}

/** 内存版 SessionMessageService 替身。 */
function fakeSessionMessageService() {
  return {
    async recordUser(_input: unknown) {},
    async recordAssistant(_input: unknown) {},
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
    const llmCalls = fakeLlmCallService();
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
    );
    await runner.kickAndWait("s1");
    expect(
      events
        .filter((e) => e.name !== SESSION_WS_EVENTS.runUsage)
        .map((e) => e.name),
    ).toEqual(["run.chunk", "run.chunk", "run.done"]);
    expect(sess.store.every((m) => m.status === "processed")).toBe(true);
  });

  it("kick：run 期间新入队的消息，结束后自动续跑", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallService();
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
      llmCalls as never,
      fakeSessionMessageService() as never,
    );
    await runner.kickAndWait("s1");
    expect(sess.store).toHaveLength(2);
    expect(sess.store.every((m) => m.status === "processed")).toBe(true);
  });

  it("kick：循环排空后再入队的消息，再次 kick 能被消费（防丢唤醒）", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallService();
    sess.enqueue("s1", "first");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
    );
    // 第一轮：消费 first，循环排空退出
    await runner.kickAndWait("s1");
    expect(sess.store.every((m) => m.status === "processed")).toBe(true);
    // 模拟竞态：循环已退出后才入队
    sess.enqueue("s1", "second");
    // 再次 kick（Controller 无条件 kick）应能消费这条
    await runner.kickAndWait("s1");
    expect(sess.store).toHaveLength(2);
    expect(sess.store.every((m) => m.status === "processed")).toBe(true);
  });

  it("出错时发 run.error 并把消息标 failed（不回滚 pending）", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallService();
    const errs: unknown[] = [];
    emitter.on("run.error", (p) => errs.push(p));
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService({ throwErr: true }) as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
    );
    await runner.kickAndWait("s1");
    expect(errs).toHaveLength(1);
    expect(sess.store[0].status).toBe("failed");
  });

  it("kickRetryAndWait：把 failed 消息重跑成 processed", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallService();
    const chunks: Array<{ messageId: string }> = [];
    emitter.on("run.chunk", (p) => chunks.push(p as { messageId: string }));
    sess.enqueue("s1", "hi");
    sess.store[0].status = "failed";
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
    );
    await runner.kickRetryAndWait("s1");
    expect(sess.store[0].status).toBe("processed");
    expect(chunks[0]?.messageId).toBe("msg-r");
  });

  it("getInflight：run 进行中可取到累加快照", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallService();
    sess.enqueue("s1", "hi");
    let snapshotDuringRun: unknown = null;
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
    );
    emitter.on("run.chunk", () => {
      snapshotDuringRun = runner.getInflight("s1");
    });
    await runner.kickAndWait("s1");
    expect(snapshotDuringRun).not.toBeNull();
    expect(runner.getInflight("s1")).toBeNull();
  });

  it("interrupt：中断 run 发 run.interrupted", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallService();
    const events: string[] = [];
    emitter.onAny((name) => events.push(String(name)));
    sess.enqueue("s1", "hi");
    const graph = {
      async *streamMessage(_s: string, _i: string, signal?: AbortSignal) {
        yield { kind: "chunk", messageId: "msg-1", delta: "部分" };
        // 第二次产出前检查中断信号
        if (signal?.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        yield { kind: "chunk", messageId: "msg-1", delta: "更多" };
      },
    };
    const runner = new RunnerService(
      sess as never,
      graph as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
    );
    emitter.on("run.chunk", () => runner.interrupt("s1"));
    await runner.kickAndWait("s1");
    expect(events).toContain("run.interrupted");
    expect(events).not.toContain("run.error");
  });

  it("onModuleInit：把遗留 processing 消息退回 pending", async () => {
    const sess = fakeSessionService();
    const llmCalls = fakeLlmCallService();
    let rolledBack = 0;
    const sessWithRollback = {
      ...sess,
      async rollbackProcessingToPending() {
        rolledBack = 3;
        return 3;
      },
    };
    const runner = new RunnerService(
      sessWithRollback as never,
      fakeGraphService() as never,
      new EventEmitter2(),
      llmCalls as never,
      fakeSessionMessageService() as never,
    );
    await runner.onModuleInit();
    expect(rolledBack).toBe(3);
  });

  it("收到 usage 事件 → 落库 + emit run.usage", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const usageEvents: unknown[] = [];
    emitter.on(SESSION_WS_EVENTS.runUsage, (p) => usageEvents.push(p));
    const llmCalls = fakeLlmCallService();
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
    );
    await runner.kickAndWait("s1");
    expect(llmCalls.records).toHaveLength(1);
    expect((llmCalls.records[0] as { sessionId: string }).sessionId).toBe("s1");
    expect((llmCalls.records[0] as { messageId: string }).messageId).toBe(
      "msg-1",
    );
    expect((llmCalls.records[0] as { inputTokens: number }).inputTokens).toBe(
      10,
    );
    expect(
      (llmCalls.records[0] as { cacheReadTokens: number }).cacheReadTokens,
    ).toBe(3);
    expect(usageEvents).toHaveLength(1);
    expect((usageEvents[0] as { messageId: string }).messageId).toBe("msg-1");
    expect((usageEvents[0] as { sessionId: string }).sessionId).toBe("s1");
  });
});
