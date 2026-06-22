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
      { findSessionOrFail: async () => {} } as unknown as SessionService,
      { getInflight: () => null } as unknown as RunnerService,
      {
        listByMessageIds: async () => [call],
        getSessionTotals: async () => null,
      } as unknown as LlmCallService,
      {
        listPage: async () => ({ messages: [msg], hasMore: false }),
      } as unknown as SessionMessageService,
      {} as unknown as SessionTitleService,
    );

    const res = await controller.history("s1", { limit: "10" });
    expect(res.byMessage[SID]).toBeDefined();
    expect(res.byMessage[SID]?.totalTokens).toBe(12);
  });
});
