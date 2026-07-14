/**
 * AGENT_RENAME_PORT —— libs/agent → server-agent 解耦端口。
 *
 * rename_agent 工具需要写 agents 表，但 libs/agent 不能依赖 server-agent 的
 * AgentService。由 server-agent 实现并绑定（同 RUNTIME_CONTEXT_PORT 的模式）。
 */
export const AGENT_RENAME_PORT = Symbol("AGENT_RENAME_PORT");

/** 改名端口。 */
export interface AgentRenamePort {
  /** 把指定 Agent 改名。必须在账号上下文内调用。 */
  rename(agentId: string, name: string): Promise<void>;
}
