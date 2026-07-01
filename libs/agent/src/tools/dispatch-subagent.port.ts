/**
 * DISPATCH_SUBAGENT_PORT —— libs/agent → server-agent 解耦端口（派子 Agent）。
 *
 * dispatch_subagent 工具经此端口把子任务委派给一个隔离子会话；server-agent 实现
 * 负责建子会话、跑到完成、回传结果。无 server-agent 环境（测试）可不注入。
 */
export const DISPATCH_SUBAGENT_PORT = Symbol("DISPATCH_SUBAGENT_PORT");

/** 派子 Agent 端口。 */
export interface DispatchSubagentPort {
  /**
   * 派发子 Agent。Phase 1a 仅前台（阻塞至完成）。返回 JSON 字符串：
   * {"subSessionId","status":"done"|"error"|"aborted","output"}
   */
  dispatch(
    params: {
      parentSessionId: string;
      parentToolCallId: string;
      task: string;
      description?: string;
      model?: string;
      background?: boolean;
    },
    signal: AbortSignal,
  ): Promise<string>;
}
