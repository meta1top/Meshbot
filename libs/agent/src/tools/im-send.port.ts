/**
 * IM_SEND_PORT —— libs/agent → server-agent 解耦端口（写侧 + HITL 确认）。
 *
 * im_send_message 工具经此端口「请求确认并发送」：server-agent 实现负责弹卡等待、
 * 用户确认后经 relay 真正发出。无 server-agent 环境（测试）可不注入。
 */
export const IM_SEND_PORT = Symbol("IM_SEND_PORT");

/** 助手发送 IM 消息（发出前经用户 HITL 确认）端口。 */
export interface ImSendPort {
  /**
   * 请求用户确认并（确认后）发送。返回结果 JSON 字符串：
   * {"status":"sent"|"cancelled"|"timeout"|"interrupted"|"error", ...}
   * fail-safe：超时/中断默认不发。
   */
  confirmAndSend(
    params: {
      sessionId: string;
      toolCallId: string;
      conversationId: string;
      content: string;
    },
    signal: AbortSignal,
  ): Promise<string>;
}
