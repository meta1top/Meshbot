import type { AgentWatchFrame } from "@meshbot/types";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SessionFrameForwarder } from "./session-frame-forwarder";

/**
 * 观察者集合空后保留常驻转发器的宽限时长（spec D5：idle 5 分钟拆除）。
 * 留缓冲是为了避免用户刷新页面 / 切页时反复挂-退监听器（一次刷新就是一次
 * unwatch + 一次 watch，几百毫秒内往返）。
 */
export const WATCH_IDLE_MS = 5 * 60 * 1000;

/** relay 出口最小接口（`ImRelayClientService` 满足之；测试可注入伪实现）。 */
export interface WatchFrameRelay {
  emitAgentWatchFrame(cloudUserId: string, frame: AgentWatchFrame): void;
}

interface WatchEntry {
  cloudUserId: string;
  localAgentId: string;
  sessionId: string;
  forwarder: SessionFrameForwarder;
  watchers: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * 设备侧**会话级常驻转发器**注册表（spec §C2，修缺口 ①「对端发起的 run
 * 本端不实时输出」）。
 *
 * 与 `RemoteRunInboundService` 的 per-run 转发器（`SessionFrameForwarder`
 * `stopOnTerminal=true`）**本质差异**：本服务的转发器 `stopOnTerminal=false`，
 * **不在 run 终止时退订**，跨多轮 run 存活到 unwatch / idle 拆除——观察者中途
 * 打开会话后，对端第二轮、第三轮的输出照样实时到达。
 *
 * **设备只镜像一份**（spec §C 取舍）：同一 sessionId 有 N 个观察者时仍只有
 * **一个**转发器、只往 relay 发**一份** `AgentWatchFrame`，由云端按
 * `sessionWatchers` 索引表 fan-out 成 N 份带 watchId 的 `AgentRunFrame`。
 * 省设备上行带宽，且观察者增减完全不改变设备侧行为。
 *
 * **泄漏防护（本设计最需防的点）**：常驻转发器没有「run 终止」这个天然终点，
 * 靠三条防线兜底——① 本服务的 idle 拆除（观察者集合空后 {@link WATCH_IDLE_MS}
 * 仍无新观察者即 `stop()` 释放全部 EventEmitter2 监听器）；② 云端在观察者 /
 * 设备断线时下发 `action:"stop"` 触发 `removeWatcher`；③ `onModuleDestroy`
 * 进程退出兜底。
 *
 * **不用 `@WithLock`**：本地轨是单进程 + 单用户，没有 Redis 锁基础设施；
 * 所有 check-then-act 都在同一 tick 内同步完成（无 await 跨越），Node 单线程
 * 语义已保证原子。
 */
@Injectable()
export class SessionWatchService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionWatchService.name);
  /** `${cloudUserId}:${sessionId}` → 该会话的常驻转发器条目。 */
  private readonly entries = new Map<string, WatchEntry>();
  /** watchId → 条目键，供 `removeWatcher` / `sessionIdOf` 反查。 */
  private readonly watchIndex = new Map<string, string>();

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly relay: WatchFrameRelay,
    /**
     * watchId 释放时的可选回调（HITL watchId 寻址防泄漏，Task 16）：
     * `RemoteRunRegistryService.watchToSession` 是本服务 `watchIndex` 的一份
     * 镜像（供 `RemoteRunControlService` 校验，两服务无直接依赖），必须在
     * 本服务任何一处删除 watchId 映射时同步通知，否则会出现「转发器已被
     * idle 拆除、但 registry 里的 watchId→sessionId 映射还在」——HITL 会对
     * 一个已无观察通道的 watchId 放行。用回调而非直接依赖
     * `RemoteRunRegistryService`：保持本服务与观察通道的传输细节解耦，
     * module 工厂里接线（`registry.unbindWatch`）。
     */
    private readonly onWatchReleased?: (watchId: string) => void,
  ) {}

  /** 条目键：账号隔离——不同账号可能有同名 sessionId（各自独立 SQLite）。 */
  private static key(cloudUserId: string, sessionId: string): string {
    return `${cloudUserId}:${sessionId}`;
  }

  /**
   * 登记一个 Session 级观察者。首个观察者进入时创建并启动常驻转发器；
   * 后续观察者只并入集合（不新建转发器，设备仍只镜像一份）。
   * 若该会话正处于 idle 宽限期，取消拆除定时器并复用既有转发器。
   */
  addWatcher(
    cloudUserId: string,
    localAgentId: string,
    sessionId: string,
    watchId: string,
  ): void {
    const key = SessionWatchService.key(cloudUserId, sessionId);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        cloudUserId,
        localAgentId,
        sessionId,
        watchers: new Set<string>(),
        idleTimer: null,
        forwarder: new SessionFrameForwarder(
          this.emitter,
          sessionId,
          {
            onFrame: (f) =>
              this.relay.emitAgentWatchFrame(cloudUserId, {
                localAgentId,
                scope: "session",
                // **必须填被观察的主会话 id，不能用 `f.sessionId`。**
                // 这个字段是**路由键**——云端按 `${deviceId}:${sessionId}` 查
                // sessionWatchers 索引决定扇给谁。子代理帧的 `f.sessionId` 是
                // **子会话 id**（转发器把 subSessionId 并进了 allowedSessions），
                // 云端按它查不到索引 → 静默丢弃；而 seq 已被消耗 → 观察者收到
                // 的序号出现空洞 → FrameSequencer 缓冲后续帧等一个永不到来的
                // seq → **整条通道从此死掉**（表现为「用过 subagent 之后远端
                // 就断了」「工具卡永远转圈」）。
                // 子会话身份不会丢：它原样保留在 `payload.sessionId` 里，渲染
                // 层照旧据此认子代理卡，与本地路径一致。
                sessionId,
                seq: f.seq,
                event: f.event,
                payload: f.payload,
              }),
            // onTerminal 故意不实现：常驻转发器不在 run 终止时做任何事，
            // run.done 本身已作为普通帧镜像出去（观察者据此收尾 UI）。
          },
          false,
        ),
      };
      this.entries.set(key, entry);
      entry.forwarder.start();
      this.logger.debug(`会话观察通道建立（session=${sessionId}）`);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.watchers.add(watchId);
    this.watchIndex.set(watchId, key);
  }

  /**
   * 注销一个观察者。集合变空后**不立即拆除**，而是起 {@link WATCH_IDLE_MS}
   * 定时器；期间有新观察者进入则取消，到期仍无人则 `stop()` 释放监听器。
   */
  removeWatcher(watchId: string): void {
    const key = this.watchIndex.get(watchId);
    if (!key) return;
    this.watchIndex.delete(watchId);
    // 与 watchIndex 的删除同一个同步 tick 内完成：不管这次移除是不是最后
    // 一个观察者（是否会触发下面的 idle 宽限计时器），watchId→sessionId 的
    // 映射都已经在**此刻**失效，registry 侧必须同步失效，不能等到 idle
    // 定时器真正拆除转发器那一刻才通知（那时该 watchId 早就不该再放行 HITL 了）。
    this.onWatchReleased?.(watchId);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.watchers.delete(watchId);
    if (entry.watchers.size > 0) return;
    const timer = setTimeout(() => {
      const cur = this.entries.get(key);
      if (!cur || cur.watchers.size > 0) return;
      cur.forwarder.stop();
      this.entries.delete(key);
      this.logger.debug(`会话观察通道 idle 拆除（session=${cur.sessionId}）`);
    }, WATCH_IDLE_MS);
    // unref 防止空闲定时器阻塞进程退出
    (timer as unknown as { unref?: () => void }).unref?.();
    entry.idleTimer = timer;
  }

  /**
   * watchId → 被观察 sessionId；未登记返 undefined。**预留未用**——HITL
   * watchId 寻址校验实际走的是 `RemoteRunRegistryService.sessionIdOfWatch`
   * （经本服务的 `onWatchReleased` 回调保持镜像同步的独立表，两服务无直接
   * 依赖），本方法目前没有生产路径调用它；如后续任务也用不上，建议清理。
   */
  sessionIdOf(watchId: string): string | undefined {
    const key = this.watchIndex.get(watchId);
    if (!key) return undefined;
    return this.entries.get(key)?.sessionId;
  }

  /** 该会话当前观察者数（0 表示处于 idle 宽限期或未建立）。 */
  watcherCount(cloudUserId: string, sessionId: string): number {
    return (
      this.entries.get(SessionWatchService.key(cloudUserId, sessionId))
        ?.watchers.size ?? 0
    );
  }

  /** 是否仍持有该会话的常驻转发器（含 idle 宽限期内的空集合状态）。 */
  isForwarding(cloudUserId: string, sessionId: string): boolean {
    return (
      this.entries.get(SessionWatchService.key(cloudUserId, sessionId))
        ?.forwarder.active === true
    );
  }

  /** 进程退出兜底：拆除全部转发器与定时器，杜绝监听器/定时器泄漏。 */
  onModuleDestroy(): void {
    for (const entry of this.entries.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.forwarder.stop();
    }
    this.entries.clear();
    // 构造函数注释（:62-72）的不变量：本服务任何一处删除 watchId 映射都必须
    // 同步通知 `onWatchReleased`。`removeWatcher` 已做到；本方法此前直接
    // `clear()` 是该不变量仅剩的失配口子——进程正在退出所以今天无害，但
    // registry 侧的镜像表理应跟着清空，不能靠"反正马上就整体退出了"当借口。
    for (const watchId of this.watchIndex.keys()) {
      this.onWatchReleased?.(watchId);
    }
    this.watchIndex.clear();
  }
}
