/**
 * ASK_QUESTION_PORT —— libs/agent → server-agent 解耦端口（HITL 问题选项）。
 * ask_question 工具经此端口「弹问题卡、挂起等用户提交」；server-agent 实现复用
 * ConfirmationService 挂起。无 server-agent 环境（测试）可不注入。
 */
export const ASK_QUESTION_PORT = Symbol("ASK_QUESTION_PORT");

/** 弹问题卡并等用户回答端口。 */
export interface AskQuestionPort {
  /** 挂起等用户提交；返回结果 JSON 字符串：
   *  {"status":"answered", answers:[...]} | {"status":"timeout"|"interrupted"}。 */
  ask(
    params: { sessionId: string; toolCallId: string },
    signal: AbortSignal,
  ): Promise<string>;
}
