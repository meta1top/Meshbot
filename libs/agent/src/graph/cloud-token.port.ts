/**
 * CLOUD_TOKEN_PORT —— libs/agent → server-agent 解耦端口（云网关 device token）。
 *
 * ModelResolver 解析云网关模型（`isCloudModel`）时，通过此端口取**当前账号**的
 * device token，用于给 `createChatModel` 的 `cloudTokenProvider` 提供活值。
 * server-agent 绑定实现（读 CloudIdentityService），libs/agent 不直接依赖它。
 * 测试或无 server-agent 环境下可不注入（@Optional），此时云模型请求带空 Bearer
 * （行为见 llm.factory.ts 的 buildCloudFetch）。
 */
export const CLOUD_TOKEN_PORT = Symbol("CLOUD_TOKEN_PORT");

/** 云网关 device token 解析端口。 */
export interface CloudTokenPort {
  /** 在账号上下文内解析当前账号的 device token；未登录/无身份返回 null。 */
  resolve(): Promise<string | null>;
}
