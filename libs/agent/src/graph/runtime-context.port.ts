/**
 * RUNTIME_CONTEXT_PORT —— libs/agent → server-agent 解耦端口。
 *
 * libs/agent 不直接依赖 server-agent 的 CloudIdentityService / SettingService /
 * AgentService，而是通过此端口接受外部注入（server-agent 实现并绑定）。
 * 测试或无 server-agent 环境下可不注入（@Optional），GraphService 会兜底。
 */
export const RUNTIME_CONTEXT_PORT = Symbol("RUNTIME_CONTEXT_PORT");

/** 当前账号 + 当前 Agent 的运行时信息端口；字段缺失返 null。 */
export interface RuntimeContextPort {
  /** 在账号 + Agent 上下文内解析运行时信息；字段缺失返 null。 */
  resolve(): Promise<{
    displayName: string | null;
    language: string | null;
    timezone: string | null;
    /** 当前 Agent 的名字；注入 system:ctx，让 agent 始终知道自己叫什么。 */
    agentName: string | null;
    /** 当前 Agent 的人格正文；由 ContextBuilder 组进 system:persona。 */
    agentSystemPrompt: string | null;
  }>;
}
