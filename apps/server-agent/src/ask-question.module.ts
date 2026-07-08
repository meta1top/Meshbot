import { ASK_QUESTION_PORT } from "@meshbot/lib-agent";
import { Global, Module } from "@nestjs/common";
import { AskQuestionService } from "./services/ask-question.service";

/**
 * @Global ask_question 模块：绑定 ASK_QUESTION_PORT 到 AskQuestionService。
 * ConfirmationService / AccountContextService 由全局模块提供（ImSendModule @Global
 * 导出唯一 ConfirmationService 实例，此处注入同一个，勿重复 provide）。
 */
@Global()
@Module({
  providers: [
    AskQuestionService,
    { provide: ASK_QUESTION_PORT, useExisting: AskQuestionService },
  ],
  exports: [ASK_QUESTION_PORT],
})
export class AskQuestionModule {}
