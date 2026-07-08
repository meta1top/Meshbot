import { openAIChatRequestSchema } from "@meshbot/types";
import { Body, Controller, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { createZodDto } from "nestjs-zod";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";
import {
  GatewayModelNotFoundError,
  ModelGatewayService,
} from "./model-gateway.service";

class ChatCompletionDto extends createZodDto(openAIChatRequestSchema) {}

/**
 * OpenAI 兼容 chat/completions 网关端点。鉴权由全局 `JwtAuthGuard` 完成
 * （Agent device token 或浏览器用户 JWT 均可），按 `req.user.orgId` 归属解析模型。
 *
 * 用 `@Res()` 直写响应体：绕开 `ResponseInterceptor` 的 `{success,data}` 信封，
 * 原样输出 OpenAI 线上格式（含错误对象），便于端侧 OpenAI SDK 直接消费。
 */
@Controller("v1")
export class ChatCompletionsController {
  constructor(private readonly gateway: ModelGatewayService) {}

  /** stream=false 走非流式；stream=true 由 Task 5 补 SSE。 */
  @Post("chat/completions")
  async completions(
    @Body() body: ChatCompletionDto,
    @CurrentUser() user: JwtMainPayload,
    @Res() res: Response,
  ): Promise<void> {
    if (!user.orgId) {
      res.status(400).json({
        error: {
          message: "no active organization",
          type: "invalid_request_error",
        },
      });
      return;
    }
    const id = `chatcmpl-${user.orgId}-${process.hrtime.bigint()}`;
    try {
      // Task 5 在此按 body.stream 分流；Phase 1 只做非流式
      const out = await this.gateway.complete(user.orgId, body, id);
      res.status(200).json(out);
    } catch (err) {
      if (err instanceof GatewayModelNotFoundError) {
        res.status(404).json({
          error: {
            message: `model not found: ${body.model}`,
            type: "invalid_request_error",
          },
        });
        return;
      }
      throw err;
    }
  }
}
