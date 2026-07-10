import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { OrgModelConfigService } from "@meshbot/main";
import { initChatModel } from "langchain/chat_models/universal";
import {
  GatewayModelNotFoundError,
  ModelGatewayService,
} from "./model-gateway.service";

jest.mock("langchain/chat_models/universal", () => ({
  initChatModel: jest.fn(),
}));

describe("ModelGatewayService", () => {
  let service: ModelGatewayService;
  let orgSvc: { resolveDecrypted: jest.Mock };

  beforeEach(() => {
    orgSvc = { resolveDecrypted: jest.fn() };
    service = new ModelGatewayService(
      orgSvc as unknown as OrgModelConfigService,
    );
    (initChatModel as jest.Mock).mockReset();
    (initChatModel as jest.Mock).mockResolvedValue({
      invoke: async () => new AIMessage("hi from provider"),
    });
  });

  it("解析 → 调 provider → 返回 OpenAI completion（含 usage）", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "openai",
      model: "gpt-4o",
      baseUrl: null,
      apiKey: "sk-x",
      contextWindow: 128000,
    });
    (initChatModel as jest.Mock).mockResolvedValue({
      invoke: async () =>
        new AIMessage({
          content: "hi from provider",
          usage_metadata: {
            input_tokens: 11,
            output_tokens: 7,
            total_tokens: 18,
          },
        }),
    });

    const out: any = await service.complete(
      "o1",
      { model: "m1", messages: [{ role: "user", content: "hi" }] },
      "cmpl-1",
    );

    expect(out.choices[0].message.content).toBe("hi from provider");
    expect(initChatModel).toHaveBeenCalledWith(
      "gpt-4o",
      expect.objectContaining({ apiKey: "sk-x" }),
    );
    // langchain usage_metadata → OpenAI usage 映射
    expect(out.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    });
  });

  it("非流式：上游无 usage_metadata → completion 不含 usage", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "openai",
      model: "gpt-4o",
      baseUrl: null,
      apiKey: "sk",
      contextWindow: null,
    });
    (initChatModel as jest.Mock).mockResolvedValue({
      invoke: async () => new AIMessage("no-usage"),
    });

    const out: any = await service.complete(
      "o1",
      { model: "m1", messages: [] },
      "id",
    );
    expect(out.usage).toBeUndefined();
  });

  it("模型不存在 → 抛 GatewayModelNotFoundError", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue(null);

    await expect(
      service.complete("o1", { model: "nope", messages: [] }, "id"),
    ).rejects.toBeInstanceOf(GatewayModelNotFoundError);
  });

  it("deepseek 模型 → 正常构建并调 provider（不再拒绝）", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-x",
      contextWindow: 64000,
    });

    const out: any = await service.complete(
      "o1",
      { model: "m-deepseek", messages: [{ role: "user", content: "hi" }] },
      "cmpl-2",
    );

    expect(out.choices[0].message.content).toBe("hi from provider");
    // 用真实模型名 deepseek-chat + deepseek provider + 注入 reasoning 的 fetch
    expect(initChatModel).toHaveBeenCalledWith(
      "deepseek-chat",
      expect.objectContaining({
        modelProvider: "deepseek",
        apiKey: "sk-x",
        configuration: expect.objectContaining({ fetch: expect.any(Function) }),
      }),
    );
  });

  it("流式：逐 chunk yield OpenAI 帧 + 末尾 usage 帧", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "openai",
      model: "gpt-4o",
      baseUrl: null,
      apiKey: "sk",
      contextWindow: null,
    });
    (initChatModel as jest.Mock).mockResolvedValue({
      stream: async function* () {
        yield new AIMessageChunk("he");
        yield new AIMessageChunk({
          content: "llo",
          usage_metadata: {
            input_tokens: 3,
            output_tokens: 2,
            total_tokens: 5,
          },
        });
      },
    });

    const frames: any[] = [];
    for await (const f of service.stream(
      "o1",
      {
        model: "m1",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      "id",
    )) {
      frames.push(f);
    }

    expect(frames[0].choices[0].delta.role).toBe("assistant");
    expect(frames[0].choices[0].delta.content).toBe("he");
    expect(frames[1].choices[0].delta.content).toBe("llo");
    // finish 帧仍在（content 帧之后）
    expect(frames.some((f) => f.choices[0]?.finish_reason === "stop")).toBe(
      true,
    );
    // 末尾 usage 帧：choices 空、带映射后的 usage（OpenAI include_usage 约定）
    const usageFrame = frames.find(
      (f) => Array.isArray(f.choices) && f.choices.length === 0 && f.usage,
    );
    expect(usageFrame.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
  });

  it("流式：上游无 usage_metadata → 不产出 usage 帧", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "openai",
      model: "gpt-4o",
      baseUrl: null,
      apiKey: "sk",
      contextWindow: null,
    });
    (initChatModel as jest.Mock).mockResolvedValue({
      stream: async function* () {
        yield new AIMessageChunk("he");
        yield new AIMessageChunk("llo");
      },
    });

    const frames: any[] = [];
    for await (const f of service.stream(
      "o1",
      { model: "m1", messages: [], stream: true },
      "id",
    )) {
      frames.push(f);
    }
    const usageFrame = frames.find(
      (f) => Array.isArray(f.choices) && f.choices.length === 0 && f.usage,
    );
    expect(usageFrame).toBeUndefined();
  });

  it("流式：模型不存在 → 抛 GatewayModelNotFoundError", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue(null);

    await expect(async () => {
      for await (const _f of service.stream(
        "o1",
        { model: "nope", messages: [] },
        "id",
      )) {
        // no-op
      }
    }).rejects.toBeInstanceOf(GatewayModelNotFoundError);
  });
});
