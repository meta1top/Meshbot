import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import {
  ModelResolver,
  ThreadStateService,
  type SummarizeResult,
} from "@meshbot/lib-agent";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Test } from "@nestjs/testing";
import { LlmCallService } from "./llm-call.service";
import { ModelConfigService } from "./model-config.service";
import { SessionMessageService } from "./session-message.service";
import {
  CompactionError,
  CompactionNothingToCompact,
  ContextCompactor,
} from "./context-compactor.service";

function buildMessages(count: number): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (let i = 0; i < count; i++) {
    out.push(new HumanMessage({ id: `h${i}`, content: "X".repeat(400) }));
    out.push(new AIMessage({ id: `a${i}`, content: "Y".repeat(400) }));
  }
  return out;
}

/** 五条稳定 id 系统消息：context-builder 每轮以稳定 id 原地替换写入的实际形态。 */
function buildSystemMessages(): BaseMessage[] {
  return [
    new SystemMessage({ id: "system:persona", content: "PERSONA_CONTENT" }),
    new SystemMessage({ id: "system:ctx", content: "CTX_CONTENT" }),
    new SystemMessage({ id: "system:skills", content: "SKILLS_CONTENT" }),
    new SystemMessage({ id: "system:mcp", content: "MCP_CONTENT" }),
    new SystemMessage({ id: "system:prompts", content: "PROMPTS_CONTENT" }),
  ];
}

/** summarize 的典型 usage：input 巨大——它要把整段待压缩历史喂给模型。 */
const USAGE = {
  inputTokens: 9_000,
  outputTokens: 300,
  totalTokens: 9_300,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
};

describe("ContextCompactor", () => {
  let compactor: ContextCompactor;
  let threadState: jest.Mocked<ThreadStateService>;
  let modelResolver: jest.Mocked<ModelResolver>;
  let modelConfig: jest.Mocked<ModelConfigService>;
  let sessionMessages: jest.Mocked<SessionMessageService>;
  let llmCalls: jest.Mocked<LlmCallService>;
  let emitter: EventEmitter2;
  let emitSpy: jest.SpyInstance;

  beforeEach(async () => {
    threadState = {
      getMessagesSnapshot: jest.fn(),
      applyCompaction: jest.fn(),
    } as unknown as jest.Mocked<ThreadStateService>;
    modelResolver = {
      summarize: jest.fn(),
    } as unknown as jest.Mocked<ModelResolver>;
    modelConfig = {
      findEnabled: jest.fn(),
    } as unknown as jest.Mocked<ModelConfigService>;
    sessionMessages = {
      recordCompactionPlaceholder: jest.fn(),
    } as unknown as jest.Mocked<SessionMessageService>;
    llmCalls = {
      record: jest.fn(),
    } as unknown as jest.Mocked<LlmCallService>;
    emitter = new EventEmitter2();
    emitSpy = jest.spyOn(emitter, "emit");
    const moduleRef = await Test.createTestingModule({
      providers: [
        ContextCompactor,
        { provide: ThreadStateService, useValue: threadState },
        { provide: ModelResolver, useValue: modelResolver },
        { provide: ModelConfigService, useValue: modelConfig },
        { provide: SessionMessageService, useValue: sessionMessages },
        { provide: EventEmitter2, useValue: emitter },
        { provide: LlmCallService, useValue: llmCalls },
      ],
    }).compile();
    compactor = moduleRef.get(ContextCompactor);
  });

  it("happy path：切分 + summarize + applyCompaction + persist + 事件", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 10_000,
    } as never);
    threadState.getMessagesSnapshot.mockResolvedValue(buildMessages(10));
    modelResolver.summarize.mockResolvedValue({
      text: "MOCK_SUMMARY",
      usage: USAGE,
      durationMs: 123,
    });
    await compactor.compact("s1");
    expect(modelResolver.summarize).toHaveBeenCalledTimes(1);
    expect(threadState.applyCompaction).toHaveBeenCalledTimes(1);
    const applyArg = threadState.applyCompaction.mock.calls[0][1] as {
      removeIds: string[];
      summaryText: string;
      keep: unknown[];
    };
    expect(applyArg.removeIds.length).toBeGreaterThan(0);
    expect(applyArg.summaryText).toBe("MOCK_SUMMARY");
    // 保留区非空，且会被重排到摘要之后
    expect(Array.isArray(applyArg.keep)).toBe(true);
    expect(applyArg.keep.length).toBeGreaterThan(0);
    // removeIds 应覆盖全部带 id 的消息（摘要区 + 保留区），不只摘要区
    expect(applyArg.removeIds.length).toBe(20);
    expect(sessionMessages.recordCompactionPlaceholder).toHaveBeenCalledTimes(
      1,
    );
    const startEmits = emitSpy.mock.calls.filter(
      ([name]) => name === SESSION_WS_EVENTS.runCompactionStart,
    );
    const doneEmits = emitSpy.mock.calls.filter(
      ([name]) => name === SESSION_WS_EVENTS.runCompactionDone,
    );
    expect(startEmits).toHaveLength(1);
    expect(doneEmits).toHaveLength(1);
  });

  it("toSummarize 为空（非 force）→ return null 不调 LLM", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 1_000_000,
    } as never);
    threadState.getMessagesSnapshot.mockResolvedValue(buildMessages(2));
    const r = await compactor.compact("s1");
    expect(r).toBeNull();
    expect(modelResolver.summarize).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("force=true 且工作集≤2 条（摘要区必为空）→ 抛 CompactionNothingToCompact", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 1_000_000,
    } as never);
    // buildMessages(1) = 1 对 = 2 条：留最近 2 条后摘要区为空，真的没东西可压。
    threadState.getMessagesSnapshot.mockResolvedValue(buildMessages(1));
    await expect(
      compactor.compact("s1", { force: true, reason: "ctx-exceeded" }),
    ).rejects.toBeInstanceOf(CompactionNothingToCompact);
  });

  it("force=true + 长对话但都在保留预算内 → 尽力压缩（留最近 2 条、其余摘要）", async () => {
    // 超大上下文窗口：预算算法判定「都在保留预算内」→ splitIdx=0；
    // force 应回退到「留最近 2 条」而非抛 CompactionNothingToCompact。
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 1_000_000,
    } as never);
    modelResolver.summarize.mockResolvedValue({
      text: "摘要",
      usage: { inputTokens: 10, outputTokens: 5 },
    } as never);
    // buildMessages(10) = 10 对 = 20 条工作集 → 留最近 2 条 → 摘要覆盖前 18 条。
    threadState.getMessagesSnapshot.mockResolvedValue(buildMessages(10));
    const r = await compactor.compact("s1", { force: true });
    expect(r).not.toBeNull();
    expect(r?.removedCount).toBe(18);
    expect(modelResolver.summarize).toHaveBeenCalledTimes(1);
  });

  it("summarize LLM 抛错 → 不动 state + emit Error + 抛 CompactionError", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 10_000,
    } as never);
    threadState.getMessagesSnapshot.mockResolvedValue(buildMessages(10));
    modelResolver.summarize.mockRejectedValue(new Error("LLM down"));
    await expect(compactor.compact("s1")).rejects.toBeInstanceOf(
      CompactionError,
    );
    expect(threadState.applyCompaction).not.toHaveBeenCalled();
    const errEmits = emitSpy.mock.calls.filter(
      ([name]) => name === SESSION_WS_EVENTS.runCompactionError,
    );
    expect(errEmits).toHaveLength(1);
  });

  it("并发同 sessionId：第二个 await 拿到第一个 Promise，不重复跑", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 10_000,
    } as never);
    threadState.getMessagesSnapshot.mockResolvedValue(buildMessages(10));
    let resolveSum!: (v: SummarizeResult) => void;
    modelResolver.summarize.mockReturnValue(
      new Promise<SummarizeResult>((r) => {
        resolveSum = r;
      }),
    );
    const p1 = compactor.compact("s1");
    const p2 = compactor.compact("s1");
    resolveSum({ text: "S", usage: null, durationMs: 0 });
    await Promise.all([p1, p2]);
    expect(modelResolver.summarize).toHaveBeenCalledTimes(1);
    expect(threadState.applyCompaction).toHaveBeenCalledTimes(1);
  });

  it("findEnabled 返 null（无启用 model）→ 抛 CompactionError", async () => {
    modelConfig.findEnabled.mockResolvedValue(null as never);
    await expect(compactor.compact("s1")).rejects.toBeInstanceOf(
      CompactionError,
    );
  });

  it("2 条 messages + 小 ctx：调整 splitIdx 后再次为 0，return null 不崩", async () => {
    // 回归测试：findSplitIndex 返 1 → splitIdx 通过第一次 zero-guard →
    // 「keep 区不足 2 条」分支把 splitIdx 推回 0 → 应再次走 null 分支，
    // 而不是 slice(0,0) 后 toSummarize[0].id 崩 TypeError。
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 4_096, // keepBudget = 409 token
    } as never);
    threadState.getMessagesSnapshot.mockResolvedValue([
      new HumanMessage({ id: "h0", content: "X".repeat(2000) }), // ~500 token，超 keepBudget
      new AIMessage({ id: "a0", content: "Y".repeat(400) }), // ~100 token
    ]);
    const r = await compactor.compact("s1");
    expect(r).toBeNull();
    expect(modelResolver.summarize).not.toHaveBeenCalled();
    expect(threadState.applyCompaction).not.toHaveBeenCalled();
    expect(sessionMessages.recordCompactionPlaceholder).not.toHaveBeenCalled();
  });

  it("getMessagesSnapshot 抛错 → 透传抛错（不 emit start）", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 10_000,
    } as never);
    threadState.getMessagesSnapshot.mockRejectedValue(
      new Error("checkpointer fail"),
    );
    await expect(compactor.compact("s1")).rejects.toThrow();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("summarize 的 token 落一行 llm_calls，带 purpose=compaction 且挂占位行 id", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 10_000,
      providerType: "openai",
      model: "gpt-x",
      name: "我的模型",
    } as never);
    threadState.getMessagesSnapshot.mockResolvedValue(buildMessages(10));
    modelResolver.summarize.mockResolvedValue({
      text: "S",
      usage: USAGE,
      durationMs: 456,
    });

    await compactor.compact("s1");

    expect(llmCalls.record).toHaveBeenCalledTimes(1);
    const arg = llmCalls.record.mock.calls[0][0];
    expect(arg.purpose).toBe("compaction");
    expect(arg.inputTokens).toBe(9_000);
    expect(arg.durationMs).toBe(456);
    expect(arg.providerType).toBe("openai");
    expect(arg.modelName).toBe("我的模型");
    // messageId 必须是压缩占位消息的 id：压缩不属于任何对话轮次，
    // 占位消息是它在时间线上的化身，且 llm_calls.message_id 非空。
    const placeholderArg =
      sessionMessages.recordCompactionPlaceholder.mock.calls[0][0];
    expect(arg.messageId).toBe(placeholderArg.id);
  });

  it("provider 未回吐 usage 时不落行，不臆造 0 污染统计", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 10_000,
      providerType: "openai",
      model: "gpt-x",
    } as never);
    threadState.getMessagesSnapshot.mockResolvedValue(buildMessages(10));
    modelResolver.summarize.mockResolvedValue({
      text: "S",
      usage: null,
      durationMs: 10,
    });

    await compactor.compact("s1");

    expect(llmCalls.record).not.toHaveBeenCalled();
  });

  it("记账失败不影响压缩成功（best-effort）", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 10_000,
      providerType: "openai",
      model: "gpt-x",
    } as never);
    threadState.getMessagesSnapshot.mockResolvedValue(buildMessages(10));
    modelResolver.summarize.mockResolvedValue({
      text: "S",
      usage: USAGE,
      durationMs: 10,
    });
    llmCalls.record.mockRejectedValue(new Error("db down"));

    await expect(compactor.compact("s1")).resolves.not.toBeNull();
    expect(threadState.applyCompaction).toHaveBeenCalledTimes(1);
  });

  describe("压缩豁免稳定 id 系统消息", () => {
    it("① 五条 system:* 消息全部豁免——不进 removeIds、不进 keep，物理位置天然留在 summary 之前", async () => {
      modelConfig.findEnabled.mockResolvedValue({
        contextWindow: 10_000,
      } as never);
      const systemMsgs = buildSystemMessages();
      threadState.getMessagesSnapshot.mockResolvedValue([
        ...systemMsgs,
        ...buildMessages(10),
      ]);
      modelResolver.summarize.mockResolvedValue({
        text: "MOCK_SUMMARY",
        usage: USAGE,
        durationMs: 1,
      });

      await compactor.compact("s1");

      const applyArg = threadState.applyCompaction.mock.calls[0][1] as {
        removeIds: string[];
        keep: BaseMessage[];
      };
      const systemIds = systemMsgs.map((m) => m.id);
      for (const id of systemIds) {
        expect(applyArg.removeIds).not.toContain(id);
      }
      const keepIds = applyArg.keep.map((m) => m.id);
      for (const id of systemIds) {
        expect(keepIds).not.toContain(id);
      }
      // 未出现在 removeIds/keep 中即代表这次 update 完全不触碰它们——
      // reducer（mergeMessages）对未提及的旧消息原样保序，物理位置留在最前，
      // 天然排在 [system..., summary, ...keep] 里 summary 之前。
    });

    it("② 摘要 LLM 输入不含 system 消息内容", async () => {
      modelConfig.findEnabled.mockResolvedValue({
        contextWindow: 10_000,
      } as never);
      threadState.getMessagesSnapshot.mockResolvedValue([
        ...buildSystemMessages(),
        ...buildMessages(10),
      ]);
      modelResolver.summarize.mockResolvedValue({
        text: "S",
        usage: USAGE,
        durationMs: 1,
      });

      await compactor.compact("s1");

      const serialized = modelResolver.summarize.mock.calls[0][0] as string;
      expect(serialized).not.toContain("PERSONA_CONTENT");
      expect(serialized).not.toContain("CTX_CONTENT");
      expect(serialized).not.toContain("[system]");
    });

    it("③ removeIds 不含任何 system:* 前缀 id", async () => {
      modelConfig.findEnabled.mockResolvedValue({
        contextWindow: 10_000,
      } as never);
      threadState.getMessagesSnapshot.mockResolvedValue([
        ...buildSystemMessages(),
        ...buildMessages(10),
      ]);
      modelResolver.summarize.mockResolvedValue({
        text: "S",
        usage: USAGE,
        durationMs: 1,
      });

      await compactor.compact("s1");

      const applyArg = threadState.applyCompaction.mock.calls[0][1] as {
        removeIds: string[];
      };
      expect(applyArg.removeIds.length).toBeGreaterThan(0);
      expect(applyArg.removeIds.every((id) => !id.startsWith("system:"))).toBe(
        true,
      );
    });

    it("④ keep≥2 语义按 rest 计数——system 不占 keep 名额", async () => {
      // keepBudget = floor(1700 * 0.1) = 170 token
      modelConfig.findEnabled.mockResolvedValue({
        contextWindow: 1_700,
      } as never);
      const systemMsgs = buildSystemMessages();
      const rest = [
        new HumanMessage({ id: "h0", content: "X".repeat(400) }), // ~100 token
        new AIMessage({ id: "a0", content: "Y".repeat(400) }), // ~100 token
        new HumanMessage({ id: "h1", content: "X".repeat(400) }), // ~100 token
        new AIMessage({ id: "a1", content: "Y".repeat(400) }), // ~100 token
      ];
      threadState.getMessagesSnapshot.mockResolvedValue([
        ...systemMsgs,
        ...rest,
      ]);
      modelResolver.summarize.mockResolvedValue({
        text: "S",
        usage: USAGE,
        durationMs: 1,
      });

      await compactor.compact("s1");

      const applyArg = threadState.applyCompaction.mock.calls[0][1] as {
        keep: BaseMessage[];
      };
      const keepIds = applyArg.keep.map((m) => m.id);
      // rest 只有 4 条：findSplitIndex 先把 splitIdx 落到只剩 a1（1 条）在
      // keep 区，keep<2 的兜底把 splitIdx 前移到 rest.length-2=2，
      // keep 变成 [h1, a1]——全程只数 rest，5 条 system 消息不占名额。
      expect(keepIds).toEqual(["h1", "a1"]);
    });

    it("⑤ 纯 system + 1 条 human 的短会话不触发压缩（rest 太少）", async () => {
      // keepBudget = floor(2_000 * 0.1) = 200 token
      modelConfig.findEnabled.mockResolvedValue({
        contextWindow: 2_000,
      } as never);
      // system 内容故意设得较长（~100 token/条，共 500 token）：若压缩工作集
      // 未剔除它们，扫描会把它们计入切分预算，误判"有得压"从而触发压缩；
      // 剔除后 rest 只剩 1 条 human，天然不够压。
      const systemMsgs = [
        new SystemMessage({ id: "system:persona", content: "S".repeat(400) }),
        new SystemMessage({ id: "system:ctx", content: "S".repeat(400) }),
        new SystemMessage({ id: "system:skills", content: "S".repeat(400) }),
        new SystemMessage({ id: "system:mcp", content: "S".repeat(400) }),
        new SystemMessage({ id: "system:prompts", content: "S".repeat(400) }),
      ];
      threadState.getMessagesSnapshot.mockResolvedValue([
        ...systemMsgs,
        new HumanMessage({ id: "h0", content: "hi" }),
      ]);

      const r = await compactor.compact("s1");

      expect(r).toBeNull();
      expect(modelResolver.summarize).not.toHaveBeenCalled();
      expect(threadState.applyCompaction).not.toHaveBeenCalled();
    });

    it("⑥ system 消息存在时，tool 配对完整性仍然保持（切分基于 rest 计算）", async () => {
      // keepBudget = floor(50 * 0.1) = 5 token
      modelConfig.findEnabled.mockResolvedValue({
        contextWindow: 50,
      } as never);
      const systemMsgs = buildSystemMessages();
      const ai1 = new AIMessage({
        id: "a1",
        content: "",
        tool_calls: [{ id: "t1", name: "bash", args: {} }],
      });
      const tool1 = new ToolMessage({
        id: "tr1",
        tool_call_id: "t1",
        content: "result",
      });
      const rest = [
        new HumanMessage({ id: "h0", content: "X".repeat(400) }), // ~100 token
        ai1, // ~10 token（tool_calls 序列化）
        tool1, // ~2 token
        new HumanMessage({ id: "h1", content: "hi" }), // ~1 token
        new HumanMessage({ id: "h2", content: "hi" }), // ~1 token
      ];
      threadState.getMessagesSnapshot.mockResolvedValue([
        ...systemMsgs,
        ...rest,
      ]);
      modelResolver.summarize.mockResolvedValue({
        text: "S",
        usage: USAGE,
        durationMs: 1,
      });

      await compactor.compact("s1");

      const applyArg = threadState.applyCompaction.mock.calls[0][1] as {
        keep: BaseMessage[];
      };
      const keepIds = applyArg.keep.map((m) => m.id);
      // ai1 的 tool_call 与 tool1 的 result 必须同进同出，不能被拆散到
      // 摘要区/保留区两边（否则喂给下一轮 LLM 时孤儿 tool_calls 会 400）。
      const aiInKeep = keepIds.includes("a1");
      const toolInKeep = keepIds.includes("tr1");
      expect(aiInKeep).toBe(toolInKeep);
      expect(keepIds).toEqual(["h1", "h2"]);
    });
  });
});
