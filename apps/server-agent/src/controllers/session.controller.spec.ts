import type { LlmCallService } from "../services/llm-call.service";
import type { RunnerService } from "../services/runner.service";
import type { SessionMessageService } from "../services/session-message.service";
import type { SessionService } from "../services/session.service";
import type { SessionTitleService } from "../services/session-title.service";
import { SessionController } from "./session.controller";

/**
 * 收口后 session_messages.id === langgraph_id，idByLanggraph 退化为恒等映射。
 * 验证 history 的 usage byMessage 投影仍按消息对外 id 命中（不回归）。
 */
describe("SessionController.history byMessage（id==langgraphId 回归）", () => {
  it("id==langgraphId 时 usage 投影仍命中 byMessage[消息id]", async () => {
    const SID = "900000000000000123";
    const msg = {
      id: SID,
      langgraphId: SID,
      role: "assistant",
      content: "hi",
      reasoning: null,
      toolCalls: null,
      toolCallId: null,
      metadata: null,
      seq: 1,
      createdAt: new Date(),
    };
    const call = {
      messageId: SID,
      providerType: "fake",
      model: "fake-model",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 3,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 5,
    };
    const controller = new SessionController(
      {
        findSessionOrFail: async () => {},
        listChildren: async () => [],
      } as unknown as SessionService,
      { getInflight: () => null } as unknown as RunnerService,
      {
        listByMessageIds: async () => [call],
        getSessionTotals: async () => null,
      } as unknown as LlmCallService,
      {
        listPage: async () => ({ messages: [msg], hasMore: false }),
      } as unknown as SessionMessageService,
      {} as unknown as SessionTitleService,
      undefined as never,
      undefined as never,
    );

    const res = await controller.history("s1", { limit: "10" });
    expect(res.byMessage[SID]).toBeDefined();
    expect(res.byMessage[SID]?.totalTokens).toBe(12);
  });
});

describe("SessionController.history 嵌套卡 subSessionId 关联", () => {
  it("dispatch 工具条目带出子会话 id；其他工具与无子会话的不带", async () => {
    const MID = "900000000000000200";
    const assistantRow = {
      id: MID,
      langgraphId: null,
      role: "assistant",
      content: "",
      reasoning: null,
      toolCalls: JSON.stringify([
        {
          id: "tc-dispatch",
          name: "dispatch_subagent",
          args: { task: "调研" },
        },
        { id: "tc-bash", name: "bash", args: { command: "ls" } },
      ]),
      toolCallId: null,
      metadata: null,
      seq: 1,
      createdAt: new Date(),
    };
    const controller = new SessionController(
      {
        findSessionOrFail: async () => {},
        listChildren: async () => [
          { id: "901000000000000001", parentToolCallId: "tc-dispatch" },
        ],
      } as unknown as SessionService,
      { getInflight: () => null } as unknown as RunnerService,
      {
        listByMessageIds: async () => [],
        getSessionTotals: async () => null,
      } as unknown as LlmCallService,
      {
        listPage: async () => ({ messages: [assistantRow], hasMore: false }),
      } as unknown as SessionMessageService,
      {} as unknown as SessionTitleService,
      undefined as never,
      undefined as never,
    );
    const res = await controller.history("s1", { limit: "10" });
    const tcs = res.messages[0]?.toolCalls ?? [];
    expect(tcs.find((t) => t.toolCallId === "tc-dispatch")?.subSessionId).toBe(
      "901000000000000001",
    );
    expect(
      tcs.find((t) => t.toolCallId === "tc-bash")?.subSessionId,
    ).toBeUndefined();
  });
});
