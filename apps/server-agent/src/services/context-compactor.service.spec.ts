import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { GraphService } from "@meshbot/agent";
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

describe("ContextCompactor", () => {
  let compactor: ContextCompactor;
  let graph: jest.Mocked<GraphService>;
  let modelConfig: jest.Mocked<ModelConfigService>;
  let sessionMessages: jest.Mocked<SessionMessageService>;
  let emitter: EventEmitter2;
  let emitSpy: jest.SpyInstance;

  beforeEach(async () => {
    graph = {
      getMessagesSnapshot: jest.fn(),
      summarize: jest.fn(),
      applyCompaction: jest.fn(),
    } as unknown as jest.Mocked<GraphService>;
    modelConfig = {
      findEnabled: jest.fn(),
    } as unknown as jest.Mocked<ModelConfigService>;
    sessionMessages = {
      recordCompactionPlaceholder: jest.fn(),
    } as unknown as jest.Mocked<SessionMessageService>;
    emitter = new EventEmitter2();
    emitSpy = jest.spyOn(emitter, "emit");
    const moduleRef = await Test.createTestingModule({
      providers: [
        ContextCompactor,
        { provide: GraphService, useValue: graph },
        { provide: ModelConfigService, useValue: modelConfig },
        { provide: SessionMessageService, useValue: sessionMessages },
        { provide: EventEmitter2, useValue: emitter },
        { provide: LlmCallService, useValue: {} },
      ],
    }).compile();
    compactor = moduleRef.get(ContextCompactor);
  });

  it("happy path：切分 + summarize + applyCompaction + persist + 事件", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 10_000,
    } as never);
    graph.getMessagesSnapshot.mockResolvedValue(buildMessages(10));
    graph.summarize.mockResolvedValue("MOCK_SUMMARY");
    await compactor.compact("s1");
    expect(graph.summarize).toHaveBeenCalledTimes(1);
    expect(graph.applyCompaction).toHaveBeenCalledTimes(1);
    const applyArg = graph.applyCompaction.mock.calls[0][1] as {
      removeIds: string[];
      summaryText: string;
    };
    expect(applyArg.removeIds.length).toBeGreaterThan(0);
    expect(applyArg.summaryText).toBe("MOCK_SUMMARY");
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
    graph.getMessagesSnapshot.mockResolvedValue(buildMessages(2));
    const r = await compactor.compact("s1");
    expect(r).toBeNull();
    expect(graph.summarize).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("force=true 且无可压缩 → 抛 CompactionNothingToCompact", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 1_000_000,
    } as never);
    graph.getMessagesSnapshot.mockResolvedValue(buildMessages(2));
    await expect(
      compactor.compact("s1", { force: true, reason: "ctx-exceeded" }),
    ).rejects.toBeInstanceOf(CompactionNothingToCompact);
  });

  it("summarize LLM 抛错 → 不动 state + emit Error + 抛 CompactionError", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 10_000,
    } as never);
    graph.getMessagesSnapshot.mockResolvedValue(buildMessages(10));
    graph.summarize.mockRejectedValue(new Error("LLM down"));
    await expect(compactor.compact("s1")).rejects.toBeInstanceOf(
      CompactionError,
    );
    expect(graph.applyCompaction).not.toHaveBeenCalled();
    const errEmits = emitSpy.mock.calls.filter(
      ([name]) => name === SESSION_WS_EVENTS.runCompactionError,
    );
    expect(errEmits).toHaveLength(1);
  });

  it("并发同 sessionId：第二个 await 拿到第一个 Promise，不重复跑", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 10_000,
    } as never);
    graph.getMessagesSnapshot.mockResolvedValue(buildMessages(10));
    let resolveSum!: (v: string) => void;
    graph.summarize.mockReturnValue(
      new Promise<string>((r) => {
        resolveSum = r;
      }),
    );
    const p1 = compactor.compact("s1");
    const p2 = compactor.compact("s1");
    resolveSum("S");
    await Promise.all([p1, p2]);
    expect(graph.summarize).toHaveBeenCalledTimes(1);
    expect(graph.applyCompaction).toHaveBeenCalledTimes(1);
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
    graph.getMessagesSnapshot.mockResolvedValue([
      new HumanMessage({ id: "h0", content: "X".repeat(2000) }), // ~500 token，超 keepBudget
      new AIMessage({ id: "a0", content: "Y".repeat(400) }), // ~100 token
    ]);
    const r = await compactor.compact("s1");
    expect(r).toBeNull();
    expect(graph.summarize).not.toHaveBeenCalled();
    expect(graph.applyCompaction).not.toHaveBeenCalled();
    expect(sessionMessages.recordCompactionPlaceholder).not.toHaveBeenCalled();
  });

  it("getMessagesSnapshot 抛错 → 透传抛错（不 emit start）", async () => {
    modelConfig.findEnabled.mockResolvedValue({
      contextWindow: 10_000,
    } as never);
    graph.getMessagesSnapshot.mockRejectedValue(new Error("checkpointer fail"));
    await expect(compactor.compact("s1")).rejects.toThrow();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
