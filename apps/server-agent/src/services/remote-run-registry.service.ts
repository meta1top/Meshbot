import { Injectable } from "@nestjs/common";

/**
 * B 侧远程 run 的 streamId → sessionId 进程内注册表。
 * 供 RemoteRunControlService 校验「control 帧携带的 sessionId 确属该 streamId 的活跃 run」(M3),
 * 防同账号内跨会话 resolve。纯内存,run 结束即清(与本地 HITL 一致,不持久化)。
 *
 * Agent 级观察通道（D2：观察者也能应答 HITL）额外挂了一张独立的
 * `watchId → sessionId` 表（`watchToSession`），供同一校验逻辑扩展到观察者
 * 寻址；两张表语义、生命周期都不同，故分表维护，见其字段注释。
 */
@Injectable()
export class RemoteRunRegistryService {
  private readonly streamToSession = new Map<string, string>();

  /** 登记一条活跃远程 run 的 streamId→sessionId 映射。 */
  bind(streamId: string, sessionId: string): void {
    this.streamToSession.set(streamId, sessionId);
  }

  /** 移除映射(run 终止退订时调用)。 */
  unbind(streamId: string): void {
    this.streamToSession.delete(streamId);
  }

  /** 反查 streamId 对应的 sessionId;未登记返 undefined。 */
  sessionIdOf(streamId: string): string | undefined {
    return this.streamToSession.get(streamId);
  }

  /**
   * watchId → sessionId（Agent 级观察通道 D2：观察者也能应答 HITL）。
   * 与 `streamToSession` **分表**：streamId 是「我发起的一次性流」，watchId 是
   * 「我观察的常驻通道」，生命周期完全不同；共用一张表会让某一侧的 unbind
   * 误清另一侧（且 id 空间无交集保证）。
   */
  private readonly watchToSession = new Map<string, string>();

  /** 登记一条观察通道的 watchId→sessionId 映射（`AgentWatchInboundService` 受理时调）。 */
  bindWatch(watchId: string, sessionId: string): void {
    this.watchToSession.set(watchId, sessionId);
  }

  /** 移除观察通道映射（unwatch / idle 拆除时调）。 */
  unbindWatch(watchId: string): void {
    this.watchToSession.delete(watchId);
  }

  /** 反查 watchId 对应的 sessionId；未登记返 undefined。 */
  sessionIdOfWatch(watchId: string): string | undefined {
    return this.watchToSession.get(watchId);
  }
}
