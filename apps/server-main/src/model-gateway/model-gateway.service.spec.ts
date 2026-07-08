import { AIMessage } from "@langchain/core/messages";
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

  it("解析 → 调 provider → 返回 OpenAI completion", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "openai",
      model: "gpt-4o",
      baseUrl: null,
      apiKey: "sk-x",
      contextWindow: 128000,
    });

    const out: any = await service.complete(
      "o1",
      { model: "m1", messages: [{ role: "user", content: "hi" }] },
      "cmpl-1",
    );

    expect(out.choices[0].message.content).toBe("hi from provider");
    // 断言用真实模型名 gpt-4o 调 initChatModel，而非端侧传的 id "m1"
    expect(initChatModel).toHaveBeenCalledWith(
      "gpt-4o",
      expect.objectContaining({ apiKey: "sk-x" }),
    );
  });

  it("模型不存在 → 抛 GatewayModelNotFoundError", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue(null);

    await expect(
      service.complete("o1", { model: "nope", messages: [] }, "id"),
    ).rejects.toBeInstanceOf(GatewayModelNotFoundError);
  });

  it("deepseek 模型 → 抛 GatewayModelNotFoundError（v1 不经网关，端侧直连）", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "deepseek",
      model: "deepseek-chat",
      baseUrl: null,
      apiKey: "sk-x",
      contextWindow: 64000,
    });

    await expect(
      service.complete(
        "o1",
        { model: "m-deepseek", messages: [{ role: "user", content: "hi" }] },
        "cmpl-2",
      ),
    ).rejects.toBeInstanceOf(GatewayModelNotFoundError);
    expect(initChatModel).not.toHaveBeenCalled();
  });
});
