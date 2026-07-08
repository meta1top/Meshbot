import { Logger } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Response } from "express";

import type { JwtMainPayload } from "../auth/jwt.strategy";
import { ChatCompletionsController } from "./chat-completions.controller";
import {
  GatewayModelNotFoundError,
  ModelGatewayService,
} from "./model-gateway.service";

type ChatBody = Parameters<ChatCompletionsController["completions"]>[0];

function fakeResponse() {
  return {
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

/** 构造一个立即抛错、从不真正 yield 的 async generator（模拟厂商 stream 中途失败）。 */
async function* throwingStream(err: unknown): AsyncGenerator<unknown> {
  for (const never of [] as unknown[]) yield never;
  throw err;
}

const mockGateway = {
  complete: jest.fn(),
  stream: jest.fn(),
};

const user = { sub: "u1", orgId: "o1" } as unknown as JwtMainPayload;

describe("ChatCompletionsController", () => {
  let controller: ChatCompletionsController;
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatCompletionsController],
      providers: [{ provide: ModelGatewayService, useValue: mockGateway }],
    }).compile();
    controller = module.get(ChatCompletionsController);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe("stream=true", () => {
    it("成功流式：SSE 头 + data 帧 + [DONE] + end", async () => {
      const chunks = [
        { id: "1", choices: [{ delta: { content: "he" } }] },
        { id: "1", choices: [{ delta: { content: "llo" } }] },
      ];
      mockGateway.stream.mockReturnValueOnce(
        (async function* () {
          for (const c of chunks) yield c;
        })(),
      );
      const res = fakeResponse();

      await controller.completions(
        { model: "m1", messages: [], stream: true } as ChatBody,
        user,
        res as unknown as Response,
      );

      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/event-stream",
      );
      expect(res.write).toHaveBeenNthCalledWith(
        1,
        `data: ${JSON.stringify(chunks[0])}\n\n`,
      );
      expect(res.write).toHaveBeenNthCalledWith(
        2,
        `data: ${JSON.stringify(chunks[1])}\n\n`,
      );
      expect(res.write).toHaveBeenLastCalledWith("data: [DONE]\n\n");
      expect(res.end).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("模型不存在 → 流式错误帧带 type=invalid_request_error，不打 error 日志", async () => {
      mockGateway.stream.mockReturnValueOnce(
        throwingStream(new GatewayModelNotFoundError("nope")),
      );
      const res = fakeResponse();

      await controller.completions(
        { model: "nope", messages: [], stream: true } as ChatBody,
        user,
        res as unknown as Response,
      );

      const written = res.write.mock.calls.map((c) => c[0]).join("");
      expect(written).toContain(
        JSON.stringify({
          error: {
            message: "model not found: nope",
            type: "invalid_request_error",
          },
        }),
      );
      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it("非 NotFound 错误 → 写 api_error 错误帧 + end + logger.error 记录净化 message（不含原始 err 对象）", async () => {
      const boom = new Error("upstream 429 rate limited, apiKey=sk-secret");
      mockGateway.stream.mockReturnValueOnce(throwingStream(boom));
      const res = fakeResponse();

      await controller.completions(
        { model: "m1", messages: [], stream: true } as ChatBody,
        user,
        res as unknown as Response,
      );

      const written = res.write.mock.calls.map((c) => c[0]).join("");
      expect(written).toContain(
        JSON.stringify({
          error: { message: "gateway error", type: "api_error" },
        }),
      );
      expect(res.end).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const loggedArgs = errorSpy.mock.calls[0];
      // 只允许 log 净化后的 message 字符串，不允许把原始 err 对象整个传进去
      expect(loggedArgs).not.toContain(boom);
      expect(
        loggedArgs.some(
          (a: unknown) => typeof a === "string" && a.includes(boom.message),
        ),
      ).toBe(true);
    });
  });

  describe("stream=false", () => {
    it("无 orgId → 400", async () => {
      const res = fakeResponse();
      await controller.completions(
        { model: "m1", messages: [] } as ChatBody,
        { sub: "u1" } as unknown as JwtMainPayload,
        res as unknown as Response,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("模型不存在 → 404", async () => {
      mockGateway.complete.mockRejectedValueOnce(
        new GatewayModelNotFoundError("nope"),
      );
      const res = fakeResponse();
      await controller.completions(
        { model: "nope", messages: [] } as ChatBody,
        user,
        res as unknown as Response,
      );
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
