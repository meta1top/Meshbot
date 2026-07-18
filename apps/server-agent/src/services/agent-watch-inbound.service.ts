import { AccountContextService } from "@meshbot/lib-agent";
import type { AgentWatchAccepted } from "@meshbot/types";
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import {
  IM_RELAY_EVENTS,
  type ImRelayAgentWatchEvent,
} from "../cloud/im-relay.events";
import { AgentService } from "./agent.service";
import { RunnerService } from "./runner.service";
import { SessionService } from "./session.service";
import { SessionWatchService } from "./session-watch.service";

/**
 * 设备侧（被观察方）入站 watch 处理：消费云端转发的 `agent.watch.forwarded`，
 * 驱动 `SessionWatchService`（Session 级常驻转发器）与 Agent 级镜像器
 * （`AgentWatchMirrorService` 按 agentId 判断有无观察者，见 Task 14），
 * 并回发 `watch_accepted`。
 *
 * 【安全门控——照搬 `RemoteRunInboundService` 的二次门控范式】
 * `forwarded.localAgentId` 是网关按可信的 CloudAgent 表把云端 `targetAgentId`
 * 解出的本地 Agent id，**只用它、绝不读云端下发的 targetAgentId**。本地
 * `agents` 表的 `remote_enabled` 是唯一真相：Agent 必须存在且
 * `remoteEnabled === true` 才允许被观察——云端登记可能过期（设备离线期间用户
 * 关掉了远程开关）。
 *
 * 【session scope 的二次门控】被观察会话必须存在且 `session.agentId === agent.id`。
 * 观察虽是读操作，但读的是**别人 Agent 的完整推理过程**（reasoning、工具入参、
 * 文件内容预览），越权同样致命：若只校验 localAgentId 的 remoteEnabled，攻击者
 * 可拿账号里任意一个 `remote_enabled=true` 的「跳板」Agent X 当 localAgentId、
 * 配合任意 sessionId 观察归属 Agent Y（用户已关闭远程开关）的会话。相等校验把
 * 这条路堵死。
 *
 * 【`action:"stop"` 无条件生效，不做任何鉴权查表】stop 来源有三：观察者显式
 * unwatch、云端观察者断线清理、云端设备断线清理。后两条是**泄漏防线**，此时
 * Agent 可能已被删除 / 已关远程开关——若 stop 也走鉴权，恰恰在最需要清理的
 * 场景下清不掉，常驻转发器就永久泄漏了。stop 只按 watchId 注销，永不拒绝。
 *
 * 这不是没有鉴权，而是**信任边界放在云端**：watchId 的权威登记方是云端网关的
 * `watchRoutes`（Task 8），它按登记时的 `userId` 校验 requester，越权 unwatch
 * 在网关层就被拒、根本不会转发到设备。所以设备只会收到两类 stop——已鉴权的
 * 合法 unwatch，以及云端自身的断线清理。设备侧重复鉴权只有坏处。
 */
@Injectable()
export class AgentWatchInboundService {
  private readonly logger = new Logger(AgentWatchInboundService.name);

  constructor(
    private readonly watches: SessionWatchService,
    private readonly runner: RunnerService,
    private readonly agents: AgentService,
    private readonly sessions: SessionService,
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  /** relay 收到云端转发的 agent.watch.forwarded（被观察设备侧入站）时触发。 */
  @OnEvent(IM_RELAY_EVENTS.agentWatchInbound)
  async onAgentWatch(evt: ImRelayAgentWatchEvent): Promise<void> {
    const { cloudUserId, forwarded } = evt;
    const { watchId, localAgentId, scope, sessionId, action } = forwarded;

    if (action === "stop") {
      // 无条件注销：三种来源（显式 unwatch / 观察者断线 / 设备断线）都必须生效。
      this.watches.removeWatcher(watchId);
      return;
    }

    const reject = (reason: AgentWatchAccepted["reason"]): void => {
      this.relay.emitAgentWatchAccepted(cloudUserId, {
        watchId,
        ok: false,
        reason,
      });
    };

    try {
      await this.account.run(cloudUserId, async () => {
        const agent = await this.agents.findOrNull(localAgentId);
        if (!agent?.remoteEnabled) {
          reject("not_found");
          return;
        }
        if (scope === "agent") {
          // Agent 级只订生命周期事件，不挂会话转发器、不带 inflight。
          // 镜像器（Task 14）按云端 watchers 表决定是否镜像，设备侧无需登记。
          this.relay.emitAgentWatchAccepted(cloudUserId, {
            watchId,
            ok: true,
            inflight: null,
          });
          return;
        }
        if (!sessionId) {
          reject("session_agent_mismatch");
          return;
        }
        const session = await this.sessions.findOrNull(sessionId);
        if (!session || session.agentId !== agent.id) {
          // 会话归属维度：与上面的「身份维度」(not_found) 是完全不同的事实，
          // 必须分开回报——合成一条会让排查分不清「Agent 不可观察」与
          // 「问错了会话」，本仓 agent_not_remotable 已因此害过一轮排查。
          reject("session_agent_mismatch");
          return;
        }
        this.watches.addWatcher(cloudUserId, agent.id, sessionId, watchId);
        // D7 中途续上：把 runner 现成的 inflight 快照随受理包带回，观察者据此
        // 渲染半截输出（无活跃 run 时为 null，不是错误）。
        this.relay.emitAgentWatchAccepted(cloudUserId, {
          watchId,
          ok: true,
          inflight: this.runner.getInflight(sessionId),
        });
      });
    } catch (err) {
      this.logger.warn(
        `watch 处理失败（watchId=${watchId}, scope=${scope}）`,
        err instanceof Error ? err.stack : err,
      );
      reject("error");
    }
  }
}
