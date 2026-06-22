/**
 * RUNTIME_CONTEXT_PORT —— libs/agent → server-agent 解耦端口。
 *
 * libs/agent 不直接依赖 server-agent 的 CloudIdentityService / SettingService，
 * 而是通过此端口接受外部注入（server-agent 实现并绑定）。
 * 测试或无 server-agent 环境下可不注入（@Optional），GraphService 会兜底。
 */
export const RUNTIME_CONTEXT_PORT = Symbol("RUNTIME_CONTEXT_PORT");

/** 当前账号运行时信息端口；字段缺失返 null。 */
export interface RuntimeContextPort {
  /** 在账号上下文内解析当前账号运行时信息；字段缺失返 null。 */
  resolve(): Promise<{
    displayName: string | null;
    language: string | null;
    timezone: string | null;
  }>;
}
