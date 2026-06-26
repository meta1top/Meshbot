import { AccountContextService } from "@meshbot/agent";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import type { PendingMessage } from "../entities/pending-message.entity";
import { RunnerService } from "./runner.service";

/** 测试默认 session 属主：runner 会按 findOwner 反查后建该账号上下文。 */
const OWNER = "u1";

/** 内存版 SessionService 替身。 */
function fakeSessionService() {
  const store: PendingMessage[] = [];
  let seq = 0;
  let claimPendingCalls = 0;
  let claimFailedCalls = 0;
  return {
    store,
    /** 反查归属账号：测试里全部 session 归 OWNER。 */
    async findOwner(_sessionId: string): Promise<string | null> {
      return OWNER;
    },
    get claimPendingCalls() {
      return claimPendingCalls;
    },
    get claimFailedCalls() {
      return claimFailedCalls;
    },
    async claimPending(sessionId: string) {
      claimPendingCalls++;
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
      claimFailedCalls++;
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
        cloudUserId: OWNER,
        sessionId,
        content,
        status: "pending",
        createdAt: new Date(),
        processedAt: null,
      } as PendingMessage);
    },
  };
}

/** 产出固定 chunk 流（含 usage 事件）的 GraphRunner 替身。 */
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
    async getLastBySession(_sessionId: string) {
      return null;
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

/** ContextCompactor 替身。 */
function fakeCompactor() {
  return {
    shouldCompactReturns: false,
    compactCalls: [] as { sessionId: string; opts?: unknown }[],
    compactError: null as Error | null,
    shouldCompact(_lastInput: number, _ctx: number) {
      return this.shouldCompactReturns;
    },
    async compact(sessionId: string, opts?: unknown) {
      this.compactCalls.push({ sessionId, opts });
      if (this.compactError) throw this.compactError;
      return { removedCount: 5, summary: "S" };
    },
  };
}

/** ModelConfigService 替身。 */
function fakeModelConfig() {
  return {
    async findEnabled() {
      return { contextWindow: 100_000 };
    },
  };
}

/** LlmCallService 替身（带 getLastBySession）。 */
function fakeLlmCallServiceWithLast(lastInput: number) {
  return {
    records: [] as unknown[],
    async record(input: unknown) {
      this.records.push(input);
    },
    async getLastBySession() {
      return { inputTokens: lastInput };
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
    const llmCalls = fakeLlmCallService();
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
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
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
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
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
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
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
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
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
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
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
    );
    emitter.on("run.chunk", () => {
      snapshotDuringRun = runner.getInflight("s1");
    });
    await runner.kickAndWait("s1");
    expect(snapshotDuringRun).not.toBeNull();
    expect(runner.getInflight("s1")).toBeNull();
  });

  it("getInflight：assistant_done 落库后、工具执行中 → messageId 为 null 但仍 streaming", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallService();
    sess.enqueue("s1", "hi");
    // reached：assistant_done 已 yield 并被 runner 处理（partialPersisted=true）后触发；
    // pausePromise：模拟长工具执行，卡住 stream 让我们在「已落库、未结束」时采样。
    let reachedResolve: () => void = () => {};
    const reached = new Promise<void>((r) => {
      reachedResolve = r;
    });
    let pauseResolve: () => void = () => {};
    const pausePromise = new Promise<void>((r) => {
      pauseResolve = r;
    });
    const graph = {
      async *streamMessage() {
        yield { kind: "reasoning", messageId: "msg-1", delta: "想一下" };
        yield {
          kind: "assistant_done",
          messageId: "msg-1",
          content: "答",
          reasoning: "想一下",
          toolCalls: [{ id: "tc-1", name: "echo", args: {} }],
        };
        // yield 之后控制权回 runner 处理 assistant_done；runner 再 next() 才执行到这里，
        // 此刻 partialPersisted 已置 true。通知测试可采样，然后卡住模拟慢 tool。
        reachedResolve();
        await pausePromise;
        yield {
          kind: "usage",
          messageId: "msg-1",
          providerType: "deepseek",
          model: "deepseek-chat",
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          durationMs: 10,
        };
      },
    };
    const runner = new RunnerService(
      sess as never,
      graph as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
    );
    const runPromise = runner.kickAndWait("s1");
    await reached;
    const snap = runner.getInflight("s1");
    pauseResolve();
    await runPromise;
    expect(snap?.status).toBe("streaming");
    expect(snap?.messageId).toBeNull();
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
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
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
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
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
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
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

  it("kickResumeAndWait：不 claim pending/failed，直接 resume 跑一次", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const events: string[] = [];
    emitter.onAny((name) => events.push(String(name)));
    const llmCalls = fakeLlmCallService();
    // 注意：不 enqueue 任何 pending / failed
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
    );
    await runner.kickResumeAndWait("s1");
    expect(events).toContain("run.done");
    // 没调 claimPending / claimFailed（因为 kickResume 不取批）
    expect(sess.claimPendingCalls).toBe(0);
    expect(sess.claimFailedCalls).toBe(0);
  });

  it("kick：run 全程跑在 session 属主的账号上下文里（按 findOwner 反查建上下文）", async () => {
    const account = new AccountContextService();
    const sess = fakeSessionService();
    // claimPending 调用时刻应已处于属主 OWNER 上下文（消费循环包在 account.run 内）。
    const seenAccounts: (string | null)[] = [];
    const origClaim = sess.claimPending.bind(sess);
    sess.claimPending = async (sessionId: string) => {
      seenAccounts.push(account.get());
      return origClaim(sessionId);
    };
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallService();
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      account,
    );
    // 入口处（account.run 之外）无上下文，证明上下文是 runner 显式建的而非外泄。
    expect(account.get()).toBeNull();
    await runner.kickAndWait("s1");
    // claimPending 至少被调一次，且每次都在 OWNER 上下文内。
    expect(seenAccounts.length).toBeGreaterThan(0);
    expect(seenAccounts.every((a) => a === OWNER)).toBe(true);
    // 退出后上下文不残留。
    expect(account.get()).toBeNull();
    expect(sess.store.every((m) => m.status === "processed")).toBe(true);
  });

  it("kick：findOwner 返回 null（找不到属主）→ 跳过，不进消费循环", async () => {
    const account = new AccountContextService();
    const sess = fakeSessionService();
    sess.findOwner = async () => null;
    let claimed = false;
    sess.claimPending = async (..._args: unknown[]) => {
      claimed = true;
      return [];
    };
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      new EventEmitter2(),
      fakeLlmCallService() as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      account,
    );
    await runner.kickAndWait("orphan");
    expect(claimed).toBe(false);
  });
});

describe("RunnerService context compaction integration", () => {
  /**
   * fakeGraphService 模拟"首次 streamMessage 抛 ctx_exceeded，重试改走
   * resumeStream 正常出"：runner 的 ctx-exceeded 兜底重试用 resume 模式
   * （HumanMessage 第一次调用时已写入 checkpointer，避免重写）。
   */
  function fakeGraphServiceCtxThenOk() {
    let streamCount = 0;
    let resumeCount = 0;
    return {
      async *streamMessage(): AsyncGenerator<unknown> {
        streamCount++;
        // 抛错前必须有一个 yield 占位（TS 才能把它推为 generator），生成器
        // 在抛错前不会 yield 出去；但函数声明需要 yield 才合法
        if (streamCount < 0) yield {};
        throw { error: { code: "context_length_exceeded" } };
      },
      async *resumeStream(): AsyncGenerator<unknown> {
        resumeCount++;
        yield { kind: "chunk", messageId: "msg-retry", delta: "OK" };
        yield {
          kind: "assistant_done",
          messageId: "msg-retry",
          content: "OK",
          reasoning: "",
          toolCalls: null,
        };
        yield {
          kind: "usage",
          messageId: "msg-retry",
          providerType: "deepseek",
          model: "deepseek-chat",
          inputTokens: 100,
          outputTokens: 1,
          totalTokens: 101,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          durationMs: 50,
        };
      },
      get streamCount() {
        return streamCount;
      },
      get resumeCount() {
        return resumeCount;
      },
    };
  }

  it("pre-check 命中阈值 → 调 compactor.compact 后才进 streamMessage", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallServiceWithLast(95_000);
    const compactor = fakeCompactor();
    compactor.shouldCompactReturns = true;
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      compactor as never,
      fakeModelConfig() as never,
      new AccountContextService(),
    );
    await runner.kickAndWait("s1");
    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0].opts).toEqual({ reason: "threshold" });
    expect(sess.store.every((m) => m.status === "processed")).toBe(true);
  });

  it("pre-check 比例 < 阈值 → 不调 compact", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallServiceWithLast(1_000);
    const compactor = fakeCompactor();
    compactor.shouldCompactReturns = false;
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      compactor as never,
      fakeModelConfig() as never,
      new AccountContextService(),
    );
    await runner.kickAndWait("s1");
    expect(compactor.compactCalls).toHaveLength(0);
  });

  it("pre-check compact 抛错 → 不进 streamMessage + 标 message failed", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallServiceWithLast(95_000);
    const compactor = fakeCompactor();
    compactor.shouldCompactReturns = true;
    compactor.compactError = new Error("compact boom");
    sess.enqueue("s1", "hi");
    const events: { name: string; payload: unknown }[] = [];
    emitter.onAny((name, payload) =>
      events.push({ name: String(name), payload }),
    );
    const graph = fakeGraphService();
    const streamSpy = jest.spyOn(graph, "streamMessage");
    const runner = new RunnerService(
      sess as never,
      graph as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      compactor as never,
      fakeModelConfig() as never,
      new AccountContextService(),
    );
    await runner.kickAndWait("s1");
    expect(streamSpy).not.toHaveBeenCalled();
    expect(sess.store.every((m) => m.status === "failed")).toBe(true);
    expect(events.map((e) => e.name)).toContain(SESSION_WS_EVENTS.runError);
  });

  it("streamMessage 抛 ctx_exceeded → 强制 compact + 重试一次成功", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallServiceWithLast(1_000); // pre-check 未命中
    const compactor = fakeCompactor();
    compactor.shouldCompactReturns = false;
    const graph = fakeGraphServiceCtxThenOk();
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      graph as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      compactor as never,
      fakeModelConfig() as never,
      new AccountContextService(),
    );
    await runner.kickAndWait("s1");
    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0].opts).toEqual({
      force: true,
      reason: "ctx-exceeded",
    });
    expect(graph.streamCount).toBe(1); // 首次 streamMessage 抛 ctx_exceeded
    expect(graph.resumeCount).toBe(1); // 重试改走 resumeStream（HumanMessage 已在 checkpointer）
    expect(sess.store.every((m) => m.status === "processed")).toBe(true);
  });

  it("streamMessage 抛非 ctx 错 → 不触发兜底，原样抛", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallServiceWithLast(1_000);
    const compactor = fakeCompactor();
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      fakeGraphService({ throwErr: true }) as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      compactor as never,
      fakeModelConfig() as never,
      new AccountContextService(),
    );
    await runner.kickAndWait("s1");
    expect(compactor.compactCalls).toHaveLength(0); // 兜底未触发
    expect(sess.store.every((m) => m.status === "failed")).toBe(true);
  });

  it("ctx_exceeded → 兜底压缩本身也失败 → 报 compactErr，messages markFailed", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallServiceWithLast(1_000); // pre-check 未命中
    const compactor = fakeCompactor();
    compactor.shouldCompactReturns = false;
    compactor.compactError = new Error("compact pipeline boom");
    const graph = fakeGraphServiceCtxThenOk();
    sess.enqueue("s1", "hi");
    const events: { name: string; payload: unknown }[] = [];
    emitter.onAny((name, payload) =>
      events.push({ name: String(name), payload }),
    );
    const runner = new RunnerService(
      sess as never,
      graph as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      compactor as never,
      fakeModelConfig() as never,
      new AccountContextService(),
    );
    await runner.kickAndWait("s1");
    // 兜底压缩被调一次（force=true, ctx-exceeded）
    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0].opts).toEqual({
      force: true,
      reason: "ctx-exceeded",
    });
    // streamMessage 调一次抛错；resumeStream 没机会进
    expect(graph.streamCount).toBe(1);
    expect(graph.resumeCount).toBe(0);
    // 消息标 failed
    expect(sess.store.every((m) => m.status === "failed")).toBe(true);
    // runError 报的是 compactErr.message（更新鲜，指向真实失败点），不是 ctx_exceeded
    const errEvent = events.find((e) => e.name === SESSION_WS_EVENTS.runError);
    expect(errEvent).toBeDefined();
    expect((errEvent?.payload as { error: string } | undefined)?.error).toBe(
      "compact pipeline boom",
    );
  });
});
