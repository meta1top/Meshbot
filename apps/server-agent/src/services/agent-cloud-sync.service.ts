import { AccountContextService } from "@meshbot/lib-agent";
import { AGENT_EVENTS, type AgentChangedEvent } from "@meshbot/types-agent";
import type { AgentSyncInput } from "@meshbot/types-main";
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { CloudClientService } from "../cloud/cloud-client.service";
import {
  IM_RELAY_EVENTS,
  type ImRelayConnectedEvent,
} from "../cloud/im-relay.events";
import { AUTH_EVENTS, type AuthorizedEvent } from "./auth.events";
import { AgentService } from "./agent.service";
import { CloudIdentityService } from "./cloud-identity.service";
import type { Agent } from "../entities/agent.entity";

/**
 * 本地推送注册服务——事件驱动，无轮询：本机 remote_enabled 的 Agent 元数据
 * 全量推送云端 `PUT /api/agent/agents` 做对账（方向与云端模型配置相反：
 * 那个是云端配置 → 本地读时代理拉取；这个是本地 Agent 变更 → 推云端）。
 *
 * 触发时机：
 * - 启动时对全部已登录账号逐个推送一次；
 * - 登录（`AUTH_EVENTS.authorized`）；
 * - relay WS（重）连成功（`IM_RELAY_EVENTS.connected`，追平离线期间的本地变更）；
 * - 本地 Agent CRUD（`AGENT_EVENTS.changed`，`AgentController` 发出）。
 *
 * 软删时机安全（关键不变量）：云端按"全量列表"对账——本次推送里没有的
 * `localAgentId` 会被云端软删。因此 `agents.list()` 抛错时**绝不能**推送
 * （不能把"查询失败"误当"0 个 remote_enabled"推空列表，那会把该设备在
 * 云端的全部远程 Agent 都软删掉）；但"查询成功、且 0 个 remote_enabled"是
 * 合法状态（用户把开关都关了），此时推空列表 `{ agents: [] }` 是正确行为。
 */
@Injectable()
export class AgentCloudSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentCloudSyncService.name);

  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
    private readonly agents: AgentService,
  ) {}

  /** 启动时对全部已登录账号逐个推送一次。 */
  async onApplicationBootstrap(): Promise<void> {
    const identities = await this.identity.listLoggedIn();
    for (const id of identities) await this.syncNow(id.cloudUserId);
  }

  /** 设备授权完成（登录）：首次推送本机已开启远程可见的 Agent。 */
  @OnEvent(AUTH_EVENTS.authorized)
  async onAuthorized({ cloudUserId }: AuthorizedEvent): Promise<void> {
    await this.syncNow(cloudUserId);
  }

  /** relay WS（重）连成功：追平离线期间的本地 Agent 变更。 */
  @OnEvent(IM_RELAY_EVENTS.connected)
  async onRelayConnected({
    cloudUserId,
  }: ImRelayConnectedEvent): Promise<void> {
    await this.syncNow(cloudUserId);
  }

  /** 本地 Agent CRUD（create/update/delete/duplicate）成功后：立即重新全量推送。 */
  @OnEvent(AGENT_EVENTS.changed)
  async onAgentChanged({ cloudUserId }: AgentChangedEvent): Promise<void> {
    await this.syncNow(cloudUserId);
  }

  /**
   * 把当前账号下 remote_enabled 的 Agent 元数据全量推送云端对账；失败静默
   * 返回 false（仅告警日志）。
   *
   * 分两段、且顺序不能颠倒：先查本地（失败直接返回，不进入推送分支），
   * 查询成功后才构造 payload 并推送——保证「查失败」与「查成功但 0 个」
   * 两种情况在推送与否上被严格区分。
   */
  async syncNow(cloudUserId: string): Promise<boolean> {
    const id = await this.identity.get(cloudUserId);
    if (!id?.deviceToken) return false;

    let localAgents: Agent[];
    try {
      localAgents = await this.account.run(cloudUserId, () =>
        this.agents.list(),
      );
    } catch (err) {
      this.logger.warn(
        `本地 Agent 查询失败，跳过本次云端推送（账号 ${cloudUserId}，避免误把查询失败当 0 个 remote 推空列表触发云端全量软删）: ${String(err)}`,
      );
      return false;
    }

    const payload: AgentSyncInput[] = localAgents
      .filter((a) => a.remoteEnabled === true)
      .map((a) => this.toSyncInput(a));

    try {
      await this.cloud.put(
        "/api/agent/agents",
        { agents: payload },
        id.deviceToken,
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `Agent 云端推送失败（账号 ${cloudUserId}）: ${String(err)}`,
      );
      return false;
    }
  }

  /** 本地 Agent Entity → 云端注册 REST 入参形状（`AgentSyncInput`）。 */
  private toSyncInput(agent: Agent): AgentSyncInput {
    return {
      localAgentId: agent.id,
      name: agent.name,
      avatar: agent.avatar,
      description: agent.description,
      visibility: agent.visibility,
    };
  }
}
