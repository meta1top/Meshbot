import { NotFoundException } from "@nestjs/common";
import type { CreateSessionDto } from "../dto/session.dto";
import type { AgentService } from "../services/agent.service";
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

describe("SessionController.create() —— agentId 解析与落库校验", () => {
  /** 组装一个仅关心 create() 的 controller；无关依赖用最小 stub。 */
  function makeController(agentOverrides: {
    ensureDefault?: jest.Mock;
    findOrThrow?: jest.Mock;
  }) {
    const createSession = jest.fn().mockResolvedValue({
      sessionId: "s1",
      session: { id: "s1" },
    });
    const sessions = { createSession } as unknown as SessionService;
    const runner = { kick: jest.fn() } as unknown as RunnerService;
    const titleService = {
      schedule: jest.fn(),
    } as unknown as SessionTitleService;
    const ensureDefault =
      agentOverrides.ensureDefault ??
      jest.fn().mockResolvedValue({ id: "default-agent" });
    const findOrThrow =
      agentOverrides.findOrThrow ??
      jest.fn().mockResolvedValue({ id: "explicit-agent" });
    const agents = {
      ensureDefault,
      findOrThrow,
      // 真实 AgentService.resolveOrDefault 就是这个实现（agentId 是 undefined/
      // null/空串 → ensureDefault；非空 → findOrThrow）——这里用 fake 复刻同一
      // 分支逻辑，让本文件既有的 ensureDefault/findOrThrow 断言继续生效。
      resolveOrDefault: jest.fn((agentId?: string) =>
        agentId ? findOrThrow(agentId) : ensureDefault(),
      ),
    } as unknown as AgentService;
    const controller = new SessionController(
      sessions,
      runner,
      {} as unknown as LlmCallService,
      {} as unknown as SessionMessageService,
      titleService,
      undefined as never,
      undefined as never,
      agents,
    );
    return { controller, createSession, agents };
  }

  it("不传 agentId → 落到 ensureDefault 的 id", async () => {
    const { controller, createSession, agents } = makeController({});
    await controller.create({ content: "hi" } as CreateSessionDto);
    expect(agents.ensureDefault).toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "default-agent" }),
    );
  });

  it("传空字符串 agentId → 不落库空串，兜底走 ensureDefault", async () => {
    const { controller, createSession, agents } = makeController({});
    await controller.create({
      content: "hi",
      agentId: "",
    } as CreateSessionDto);
    expect(agents.ensureDefault).toHaveBeenCalled();
    expect(agents.findOrThrow).not.toHaveBeenCalled();
    const arg = createSession.mock.calls[0]?.[0] as { agentId: string };
    expect(arg.agentId).not.toBe("");
    expect(arg.agentId).toBe("default-agent");
  });

  it("传不存在（或不属于当前账号）的 agentId → 抛 404，不落库", async () => {
    const findOrThrow = jest
      .fn()
      .mockRejectedValue(new NotFoundException("Agent 不存在：ghost"));
    const { controller, createSession } = makeController({ findOrThrow });
    await expect(
      controller.create({
        content: "hi",
        agentId: "ghost",
      } as CreateSessionDto),
    ).rejects.toThrow(NotFoundException);
    expect(findOrThrow).toHaveBeenCalledWith("ghost");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("传合法 agentId → 校验存在后原样落库", async () => {
    const { controller, createSession, agents } = makeController({});
    await controller.create({
      content: "hi",
      agentId: "explicit-agent",
    } as CreateSessionDto);
    expect(agents.findOrThrow).toHaveBeenCalledWith("explicit-agent");
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "explicit-agent" }),
    );
  });
});
