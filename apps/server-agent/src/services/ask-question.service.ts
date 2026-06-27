import { AccountContextService } from "@meshbot/agent";
import type { AskQuestionPort } from "@meshbot/agent";
import type { AnswerItem } from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import { ConfirmationService } from "./confirmation.service";

/** 用户提交的回答载荷（answer 端点 resolve 的内容）。 */
export type AnswerPayload = { answers: AnswerItem[] };

/** 问题卡挂起超时（无人提交则 fail-safe 不算回答）。 */
export const ASK_CONFIRM_TIMEOUT_MS = 120_000;

/**
 * ASK_QUESTION_PORT 实现：经 ConfirmationService 挂起等用户提交，返回 {status} JSON。
 */
@Injectable()
export class AskQuestionService implements AskQuestionPort {
  constructor(
    private readonly confirmation: ConfirmationService,
    private readonly account: AccountContextService,
  ) {}

  /** 挂起等用户提交答案；超时/中断 fail-safe。 */
  async ask(
    params: { sessionId: string; toolCallId: string },
    signal: AbortSignal,
  ): Promise<string> {
    const key = ConfirmationService.key(
      this.account.getOrThrow(),
      params.sessionId,
      params.toolCallId,
    );
    const outcome = await this.confirmation.waitForDecision<AnswerPayload>(
      key,
      signal,
      ASK_CONFIRM_TIMEOUT_MS,
    );
    if (outcome === "timeout") {
      return JSON.stringify({ status: "timeout" });
    }
    if (outcome === "aborted") {
      return JSON.stringify({ status: "interrupted" });
    }
    return JSON.stringify({ status: "answered", answers: outcome.answers });
  }
}
