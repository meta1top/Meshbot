import {
  AccountContextService,
  AgentContextService,
  ModelRunContext,
} from "@meshbot/lib-agent";
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
    /**
     * 按 id 查 session：测试默认都是主 Agent 会话（kind: "user"），非子 Agent，
     * agentId 默认 "agent-1"（Task 2 保证 sessions.agent_id NOT NULL）。
     */
    async findOrNull(sessionId: string): Promise<{
      id: string;
      kind: "user" | "subagent";
      agentId: string;
      modelConfigId?: string | null;
    }> {
      return { id: sessionId, kind: "user", agentId: "agent-1" };
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
function fakeGraphRunner(opts?: { throwErr?: boolean }) {
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

/**
 * AgentService 替身：默认 agent 无 defaultModelConfigId（三级优先级测试里按需覆盖）；
 * ensureDefault 供 session.agentId 缺失时兜底（正常路径不会走到，Task 2 已保证 NOT NULL）。
 */
function fakeAgentService(defaultModelConfigId: string | null = null) {
  return {
    async findOrNull(id: string) {
      return { id, defaultModelConfigId };
    },
    async ensureDefault() {
      return { id: "agent-default", defaultModelConfigId };
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
      fakeGraphRunner() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      fakeGraphRunner() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      fakeGraphRunner() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      fakeGraphRunner({ throwErr: true }) as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      fakeGraphRunner() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      fakeGraphRunner() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
    );
    const runPromise = runner.kickAndWait("s1");
    await reached;
    const snap = runner.getInflight("s1");
    pauseResolve();
    await runPromise;
    expect(snap?.status).toBe("streaming");
    expect(snap?.messageId).toBeNull();
  });

  it("getInflight：纯工具决策轮（无 chunk/reasoning）也设 messageId 并累计 args 前缀", async () => {
    const sess = fakeSessionService();
    const emitter = new EventEmitter2();
    const llmCalls = fakeLlmCallService();
    sess.enqueue("s1", "写个文件");
    // 云网关下的「决策轮」：只流 tool_call args，没有 reasoning / chunk 事件。
    // 卡在 args 流中途采样 —— 这正是「中途打开会话」看到的服务端状态。
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
        yield {
          kind: "tool_call_args",
          messageId: "msg-1",
          toolCallId: "tc-1",
          index: 0,
          name: "write_file",
          delta: '{"path":"a.txt","con',
        };
        yield {
          kind: "tool_call_args",
          messageId: "msg-1",
          toolCallId: "tc-1",
          index: 0,
          name: "write_file",
          delta: 'tent":"he',
        };
        reachedResolve();
        await pausePromise;
        yield {
          kind: "assistant_done",
          messageId: "msg-1",
          content: "",
          reasoning: "",
          toolCalls: [{ id: "tc-1", name: "write_file", args: {} }],
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
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
    );
    const runPromise = runner.kickAndWait("s1");
    await reached;
    const snap = runner.getInflight("s1");
    pauseResolve();
    await runPromise;
    expect(snap?.messageId).toBe("msg-1");
    expect(snap?.toolCalls).toEqual([
      {
        toolCallId: "tc-1",
        name: "write_file",
        argsText: '{"path":"a.txt","content":"he',
      },
    ]);
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
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      fakeGraphRunner() as never,
      new EventEmitter2(),
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      fakeGraphRunner() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      fakeGraphRunner() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      fakeGraphRunner() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      account,
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      fakeGraphRunner() as never,
      new EventEmitter2(),
      fakeLlmCallService() as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      account,
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
    );
    await runner.kickAndWait("orphan");
    expect(claimed).toBe(false);
  });

  it("consumeRunStream 全程运行在 ModelRunContext 内且带 session 的 modelConfigId", async () => {
    const sess = fakeSessionService();
    sess.findOrNull = async (sessionId: string) => ({
      id: sessionId,
      kind: "subagent" as const,
      agentId: "agent-1",
      modelConfigId: "mc-9",
    });
    const runCtx = new ModelRunContext();
    // graphRunner.streamMessage 的 mock 在被迭代时读取 runCtx.getOverrideId()
    const seen: Array<string | null> = [];
    const graph = {
      async *streamMessage() {
        seen.push(runCtx.getOverrideId());
        yield {
          kind: "assistant_done",
          messageId: "m1",
          content: "hi",
          reasoning: "",
          toolCalls: null,
        };
      },
    };
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      graph as never,
      new EventEmitter2(),
      fakeLlmCallService() as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      runCtx,
      new AgentContextService(),
      fakeAgentService() as never,
    );
    await runner.kickAndWait("s1");
    expect(seen).toEqual(["mc-9"]);
  });

  it("run 期间 ALS 里是该会话绑定的 agentId", async () => {
    const sess = fakeSessionService();
    sess.findOrNull = async (sessionId: string) => ({
      id: sessionId,
      kind: "user" as const,
      agentId: "agent-42",
      modelConfigId: null,
    });
    const agentCtx = new AgentContextService();
    const seen: (string | null)[] = [];
    const graph = {
      async *streamMessage() {
        seen.push(agentCtx.get());
        yield {
          kind: "assistant_done",
          messageId: "m1",
          content: "hi",
          reasoning: "",
          toolCalls: null,
        };
      },
    };
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      graph as never,
      new EventEmitter2(),
      fakeLlmCallService() as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      agentCtx,
      fakeAgentService() as never,
    );
    // 入口处（run 之外）无上下文，证明上下文是 runner 显式建的而非外泄。
    expect(agentCtx.get()).toBeNull();
    await runner.kickAndWait("s1");
    expect(seen).toEqual(["agent-42"]);
    // 退出后上下文不残留。
    expect(agentCtx.get()).toBeNull();
  });

  it("模型三级优先级：会话覆盖 > agent 默认 > 都没有则传 null", async () => {
    const overrides: (string | null)[] = [];
    /** ModelRunContext 替身：只记录传入的覆盖 id，不需要真做 ALS。 */
    const modelRunCtx = {
      run(id: string | null, fn: () => unknown) {
        overrides.push(id);
        return fn();
      },
    };

    const graph = {
      async *streamMessage() {
        yield {
          kind: "assistant_done",
          messageId: "m1",
          content: "hi",
          reasoning: "",
          toolCalls: null,
        };
      },
    };

    // 情形 1：session.modelConfigId 为 null，agent.defaultModelConfigId = "m-agent"
    // → 期望三级优先级取 agent 默认值。
    const sess1 = fakeSessionService();
    sess1.findOrNull = async (sessionId: string) => ({
      id: sessionId,
      kind: "user" as const,
      agentId: "agent-1",
      modelConfigId: null,
    });
    sess1.enqueue("s1", "hi");
    const runner1 = new RunnerService(
      sess1 as never,
      graph as never,
      new EventEmitter2(),
      fakeLlmCallService() as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      modelRunCtx as never,
      new AgentContextService(),
      fakeAgentService("m-agent") as never,
    );
    await runner1.kickAndWait("s1");

    // 情形 2：session.modelConfigId = "m-session" → 会话覆盖优先于 agent 默认值。
    const sess2 = fakeSessionService();
    sess2.findOrNull = async (sessionId: string) => ({
      id: sessionId,
      kind: "user" as const,
      agentId: "agent-1",
      modelConfigId: "m-session",
    });
    sess2.enqueue("s2", "hi");
    const runner2 = new RunnerService(
      sess2 as never,
      graph as never,
      new EventEmitter2(),
      fakeLlmCallService() as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      modelRunCtx as never,
      new AgentContextService(),
      fakeAgentService("m-agent") as never,
    );
    await runner2.kickAndWait("s2");

    // 情形 3：session.modelConfigId 与 agent.defaultModelConfigId 都没有 → 传 null。
    const sess3 = fakeSessionService();
    sess3.findOrNull = async (sessionId: string) => ({
      id: sessionId,
      kind: "user" as const,
      agentId: "agent-1",
      modelConfigId: null,
    });
    sess3.enqueue("s3", "hi");
    const runner3 = new RunnerService(
      sess3 as never,
      graph as never,
      new EventEmitter2(),
      fakeLlmCallService() as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      modelRunCtx as never,
      new AgentContextService(),
      fakeAgentService(null) as never,
    );
    await runner3.kickAndWait("s3");

    expect(overrides).toEqual(["m-agent", "m-session", null]);
  });

  it("session.modelConfigId 为空字符串时降级到 agent 默认值（复现缺陷 1：?? 挡不住空串）", async () => {
    const overrides: (string | null)[] = [];
    const modelRunCtx = {
      run(id: string | null, fn: () => unknown) {
        overrides.push(id);
        return fn();
      },
    };
    const graph = {
      async *streamMessage() {
        yield {
          kind: "assistant_done",
          messageId: "m1",
          content: "hi",
          reasoning: "",
          toolCalls: null,
        };
      },
    };
    const sess = fakeSessionService();
    sess.findOrNull = async (sessionId: string) => ({
      id: sessionId,
      kind: "user" as const,
      agentId: "agent-1",
      modelConfigId: "",
    });
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      graph as never,
      new EventEmitter2(),
      fakeLlmCallService() as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      modelRunCtx as never,
      new AgentContextService(),
      fakeAgentService("m-agent") as never,
    );
    await runner.kickAndWait("s1");
    // 期望：空串会话覆盖被当作"未覆盖"，降级到 agent 默认值 "m-agent"。
    // 修复前 `session?.modelConfigId ?? agent?.defaultModelConfigId ?? null`
    // 会把 "" 原样传下去，这里会拿到 ""。
    expect(overrides).toEqual(["m-agent"]);
  });

  it("session.agentId 为空字符串时走 ensureDefault 兜底，不把空串压进 ALS（复现缺陷 2）", async () => {
    const agentCtx = new AgentContextService();
    const seen: (string | null)[] = [];
    const graph = {
      async *streamMessage() {
        // 直接读 ALS 里的 agentId：修复前会是 ""（被压进 ALS 的空串），
        // 修复后应是 fakeAgentService().ensureDefault() 返回的 "agent-default"。
        seen.push(agentCtx.get());
        yield {
          kind: "assistant_done",
          messageId: "m1",
          content: "hi",
          reasoning: "",
          toolCalls: null,
        };
      },
    };
    const sess = fakeSessionService();
    sess.findOrNull = async (sessionId: string) => ({
      id: sessionId,
      kind: "user" as const,
      agentId: "",
      modelConfigId: null,
    });
    sess.enqueue("s1", "hi");
    const runner = new RunnerService(
      sess as never,
      graph as never,
      new EventEmitter2(),
      fakeLlmCallService() as never,
      fakeSessionMessageService() as never,
      fakeCompactor() as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      agentCtx,
      fakeAgentService() as never,
    );
    await runner.kickAndWait("s1");
    expect(seen).toEqual(["agent-default"]);
  });
});

describe("RunnerService context compaction integration", () => {
  /**
   * fakeGraphRunner 模拟"首次 streamMessage 抛 ctx_exceeded，重试改走
   * resumeStream 正常出"：runner 的 ctx-exceeded 兜底重试用 resume 模式
   * （HumanMessage 第一次调用时已写入 checkpointer，避免重写）。
   */
  function fakeGraphRunnerCtxThenOk() {
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
      fakeGraphRunner() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      compactor as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      fakeGraphRunner() as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      compactor as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
    const graph = fakeGraphRunner();
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
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
    const graph = fakeGraphRunnerCtxThenOk();
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
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
      fakeGraphRunner({ throwErr: true }) as never,
      emitter,
      llmCalls as never,
      fakeSessionMessageService() as never,
      compactor as never,
      fakeModelConfig() as never,
      new AccountContextService(),
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
    const graph = fakeGraphRunnerCtxThenOk();
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
      new ModelRunContext(),
      new AgentContextService(),
      fakeAgentService() as never,
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
