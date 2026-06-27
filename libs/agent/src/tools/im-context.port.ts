/**
 * IM_CONTEXT_PORT —— libs/agent → server-agent 解耦端口。
 *
 * IM 工具不直接依赖 server-agent 的 CloudImService / IM schema，而是经此端口取数：
 * server-agent 用 CloudImService 实现并绑定（格式化为紧凑 JSON 字符串）。
 * 无 server-agent 环境（测试）可不注入。
 */
export const IM_CONTEXT_PORT = Symbol("IM_CONTEXT_PORT");

/** IM 上下文只读端口；返回已序列化 JSON 字符串（直接作 ToolMessage 内容）。 */
export interface ImContextPort {
  /** 所有会话 + 未读概览。 */
  unreadOverview(): Promise<string>;
  /** 某频道/私聊的历史消息（limit 默认实现方决定）。 */
  readConversation(
    conversationId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<string>;
  /** 频道成员列表。 */
  listMembers(conversationId: string): Promise<string>;
}
