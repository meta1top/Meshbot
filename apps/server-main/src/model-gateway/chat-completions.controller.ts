import { openAIChatRequestSchema } from "@meshbot/types";
import { Body, Controller, Logger, Post, Res } from "@nestjs/common";
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
  private readonly logger = new Logger(ChatCompletionsController.name);

  constructor(private readonly gateway: ModelGatewayService) {}

  /** stream=false 走非流式 JSON；stream=true 走 SSE 逐帧转发。 */
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

    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      try {
        for await (const frame of this.gateway.stream(user.orgId, body, id)) {
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
      } catch (err) {
        if (err instanceof GatewayModelNotFoundError) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: `model not found: ${body.model}`,
                type: "invalid_request_error",
              },
            })}\n\n`,
          );
        } else {
          // 流式期最易在生产失败的路径（厂商超时/限流/网络）：只 log 净化后的
          // message，绝不 log 原始 err 对象——部分 HTTP client SDK 会把含
          // apiKey 的 request header 挂在 err 上。
          this.logger.error(
            `chat/completions 流式转发失败：${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          res.write(
            `data: ${JSON.stringify({
              error: { message: "gateway error", type: "api_error" },
            })}\n\n`,
          );
        }
      }
      res.end();
      return;
    }

    try {
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
