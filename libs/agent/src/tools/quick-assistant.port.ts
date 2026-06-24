/**
 * QUICK_ASSISTANT_PORT —— libs/agent → server-agent 解耦端口。
 *
 * 改名 tool 不直接依赖 server-agent 的 SettingService / 事件总线，而是经此端口落地：
 * server-agent 实现（写 Setting + 发 ws renamed 事件，实时刷新 dock 标题）并绑定。
 * 无 server-agent 环境（测试）可不注入。
 */
export const QUICK_ASSISTANT_PORT = Symbol("QUICK_ASSISTANT_PORT");

/** 随手问改名端口。 */
export interface QuickAssistantPort {
  /** 给随手问改名（持久化 + 实时事件由实现方负责）。 */
  rename(name: string): Promise<void>;
}
