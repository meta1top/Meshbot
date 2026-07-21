import { AccountContextService } from "@meshbot/lib-agent";
import { AppError } from "@meshbot/common";
import type { DeviceView } from "@meshbot/types";
import type { RemoteAgentView } from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";

import { CloudClientService } from "../cloud/cloud-client.service";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { AgentService } from "./agent.service";
import { CloudIdentityService } from "./cloud-identity.service";

/** 云端 `GET /api/agents`(types-main AgentView) 在本服务用到的最小形状。 */
interface CloudAgentSummary {
  id: string;
  deviceId: string;
  localAgentId: string;
  name: string;
  avatar: string;
  description: string | null;
}

/**
 * 代理云端 Agent 注册表供 web-agent 列「其他设备的远程 Agent」（计划二 2c·A1）。
 * 用 device token 拉云端 `GET /api/agents`（全量已注册 Agent）+ `GET /api/devices`
 * （拼宿主设备名 + 判本机），过滤掉本机设备自身的 Agent（本机 Agent 走本地列表，
 * 不算远程），再逐个宿主设备补在线态。web-agent 据此渲染副标题 + 离线灰化。
 *
 * 「本机」判据用**两条互补规则的或**（命中任一即视为本机、剔除）：
 * 1. `localAgentId` 落在本地 `AgentService.list()` 里 —— 主判据，fail-closed。
 *    本地 SQLite `agent.id` 是雪花，跨设备撞车概率为零，且不依赖云端任何状态。
 * 2. `deviceId === currentDeviceId`（`GET /api/devices` 的 `isCurrent`）—— 兜底。
 *
 * 为什么不能只留第 2 条（历史 bug）：server-agent 本地根本没有 deviceId
 *（`cloud_identity` 只存不透明的 `device_token`，解不出设备 id），`isCurrent`
 * 是唯一来源且 **fail-open**——一旦 `isCurrent` 全 false，或同一台机器在云端存在
 * 第二行 device（旧行吊销后重新授权 / `machineIdSync()` 抛错降级每次新建设备），
 * 本机 Agent 就会被当成远程 Agent 重复列出（旧 device 行上的 `cloud_agent`
 * 不会被 `syncForDevice` 软删 → 永久幽灵行）。第 1 条对这两种错配同时免疫。
 *
 * 已知取舍：若用户把 `~/.meshbot` 整份克隆到另一台设备，两机持有相同 localAgentId，
 * 那台**真远程** Agent 会被误滤。极端场景，接受。
 */
@Injectable()
export class RemoteAgentsService {
  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
    private readonly agents: AgentService,
  ) {}

  /** 列出同账号其他设备上已注册的远程 Agent（含宿主设备名 + 在线态）。 */
  async listRemoteAgents(): Promise<RemoteAgentView[]> {
    const token = await this.token();
    const [agents, devices, localAgents] = await Promise.all([
      this.cloud.get<CloudAgentSummary[]>("/api/agents", token),
      this.cloud.get<DeviceView[]>("/api/devices", token),
      this.agents.list(),
    ]);
    const currentDeviceId = devices.find((d) => d.isCurrent)?.id ?? null;
    const deviceNameById = new Map(devices.map((d) => [d.id, d.name]));
    const localAgentIds = new Set(localAgents.map((a) => a.id));
    const remote = agents.filter(
      (a) =>
        !localAgentIds.has(a.localAgentId) && a.deviceId !== currentDeviceId,
    );
    const distinctDeviceIds = [...new Set(remote.map((a) => a.deviceId))];
    const onlineEntries = await Promise.all(
      distinctDeviceIds.map(async (deviceId) => {
        try {
          const { online } = await this.cloud.get<{ online: boolean }>(
            `/api/devices/${deviceId}/online`,
            token,
          );
          return [deviceId, online] as const;
        } catch {
          return [deviceId, false] as const;
        }
      }),
    );
    const onlineById = new Map(onlineEntries);
    return remote.map((a) => ({
      id: a.id,
      deviceId: a.deviceId,
      localAgentId: a.localAgentId,
      name: a.name,
      avatar: a.avatar,
      description: a.description,
      deviceName: deviceNameById.get(a.deviceId) ?? a.deviceId,
      deviceOnline: onlineById.get(a.deviceId) ?? false,
    }));
  }

  /** 取当前账号的 device token；未登录/无 token → AUTH_UNAUTHORIZED。 */
  private async token(): Promise<string> {
    const id = await this.identity.get(this.account.getOrThrow());
    if (!id?.deviceToken) {
      throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    }
    return id.deviceToken;
  }
}
