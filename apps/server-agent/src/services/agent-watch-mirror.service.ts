import { AccountContextService } from "@meshbot/lib-agent";
import type { AgentWatchFrame } from "@meshbot/types";
import {
  SESSION_LIFECYCLE_EVENTS,
  SESSION_STATUS_EVENTS,
  type SessionCreatedEvent,
  type SessionDeletedEvent,
  type SessionRenamedEvent,
  type SessionStatusChangedEvent,
} from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ImRelayClientService } from "../cloud/im-relay-client.service";

/**
 * Agent 级会话生命周期镜像器（spec §C1，修缺口 ②「A 远程建的会话，B 上不
 * 实时出现」）。
 *
 * 本地已有一套 `ws/events` 全局总线事件（`session.created/deleted/renamed/
 * status_changed`），但**只走本机 ws/events，不经 relay**——所以远端建的会话、
 * 改的名，对端要刷新才看得到。本服务就是那条**多出来的出口**：同一批事件，
 * 在**有 Agent 级观察者时**额外镜像一份上 relay，云端按 `agentWatchers` 索引
 * fan-out 给各观察者。
 *
 * **不改事件本身**（spec §C1 明确）：本服务只 `@OnEvent` 旁听，不影响既有
 * `EventsGateway` 的本机下发路径。
 *
 * **无观察者 = 零成本**：`hasWatcher` 是一次 Map 查找，没人看时直接 return，
 * 不组帧、不碰 relay。
 *
 * **设备只镜像一份**：同一 Agent 有 N 个观察者时仍只发一份（同
 * `SessionWatchService` 的取舍），云端负责扇出。
 *
 * **账号隔离**：事件发射方（`SessionService`）总在某个账号的
 * `AccountContextService` 上下文内，本服务据此取 `cloudUserId` 并与观察者登记
 * 的账号比对——取不到账号或账号不匹配一律不镜像，宁可退化为「不实时」也绝不
 * 跨账号泄漏会话标题。
 */
@Injectable()
export class AgentWatchMirrorService {
  /** `${cloudUserId}:${localAgentId}` → 观察者 watchId 集合。 */
  private readonly watchers = new Map<string, Set<string>>();
  /** watchId → 上面的键，供 `removeWatcher` 反查。 */
  private readonly watchIndex = new Map<string, string>();
  /** 每个被观察 Agent 的镜像帧序号（观察者按此重排）。 */
  private readonly seqs = new Map<string, number>();

  constructor(
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  private static key(cloudUserId: string, localAgentId: string): string {
    return `${cloudUserId}:${localAgentId}`;
  }

  /** 登记一个 Agent 级观察者（`AgentWatchInboundService` 在 scope="agent" 时调）。 */
  addWatcher(cloudUserId: string, localAgentId: string, watchId: string): void {
    const key = AgentWatchMirrorService.key(cloudUserId, localAgentId);
    let set = this.watchers.get(key);
    if (!set) {
      set = new Set<string>();
      this.watchers.set(key, set);
    }
    set.add(watchId);
    this.watchIndex.set(watchId, key);
  }

  /**
   * 注销一个 Agent 级观察者。集合空即删键 + 清 seq 计数——Agent 级没有
   * Session 级那种「刷新期间反复挂退」的成本（这里挂的不是 EventEmitter2
   * 监听器，只是一个 Set 条目），故不需要 idle 宽限期，立即回收。
   */
  removeWatcher(watchId: string): void {
    const key = this.watchIndex.get(watchId);
    if (!key) return;
    this.watchIndex.delete(watchId);
    const set = this.watchers.get(key);
    if (!set) return;
    set.delete(watchId);
    if (set.size === 0) {
      this.watchers.delete(key);
      this.seqs.delete(key);
    }
  }

  /** 该 Agent 当前是否有观察者。 */
  hasWatcher(cloudUserId: string, localAgentId: string): boolean {
    return (
      (this.watchers.get(AgentWatchMirrorService.key(cloudUserId, localAgentId))
        ?.size ?? 0) > 0
    );
  }

  @OnEvent(SESSION_LIFECYCLE_EVENTS.created)
  onCreated(payload: SessionCreatedEvent): void {
    this.mirror(
      payload.agentId,
      payload.session.id,
      SESSION_LIFECYCLE_EVENTS.created,
      payload,
    );
  }

  @OnEvent(SESSION_LIFECYCLE_EVENTS.deleted)
  onDeleted(payload: SessionDeletedEvent): void {
    this.mirror(
      payload.agentId,
      payload.sessionId,
      SESSION_LIFECYCLE_EVENTS.deleted,
      payload,
    );
  }

  @OnEvent(SESSION_LIFECYCLE_EVENTS.renamed)
  onRenamed(payload: SessionRenamedEvent): void {
    this.mirror(
      payload.agentId,
      payload.sessionId,
      SESSION_LIFECYCLE_EVENTS.renamed,
      payload,
    );
  }

  @OnEvent(SESSION_STATUS_EVENTS.changed)
  onStatusChanged(payload: SessionStatusChangedEvent): void {
    this.mirror(
      payload.agentId,
      payload.sessionId,
      SESSION_STATUS_EVENTS.changed,
      payload,
    );
  }

  /** 有观察者才组帧上 relay；无人看时零成本返回。 */
  private mirror(
    localAgentId: string,
    sessionId: string,
    event: string,
    payload: unknown,
  ): void {
    const cloudUserId = this.account.get();
    if (!cloudUserId) return; // 无账号上下文：不猜，宁可不实时也不跨账号泄漏
    const key = AgentWatchMirrorService.key(cloudUserId, localAgentId);
    if ((this.watchers.get(key)?.size ?? 0) === 0) return;
    const seq = (this.seqs.get(key) ?? 0) + 1;
    this.seqs.set(key, seq);
    this.relay.emitAgentWatchFrame(cloudUserId, {
      localAgentId,
      scope: "agent",
      sessionId,
      seq,
      event,
      payload,
    } satisfies AgentWatchFrame);
  }
}
