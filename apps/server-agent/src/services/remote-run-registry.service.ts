import { Injectable } from "@nestjs/common";

/**
 * B 侧远程 run 的 streamId → sessionId 进程内注册表。
 * 供 RemoteRunControlService 校验「control 帧携带的 sessionId 确属该 streamId 的活跃 run」(M3),
 * 防同账号内跨会话 resolve。纯内存,run 结束即清(与本地 HITL 一致,不持久化)。
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
}
