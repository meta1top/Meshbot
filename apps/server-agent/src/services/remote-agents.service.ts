import { AccountContextService } from "@meshbot/lib-agent";
import { AppError } from "@meshbot/common";
import type { DeviceView } from "@meshbot/types";
import type { RemoteAgentView } from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";

import { CloudClientService } from "../cloud/cloud-client.service";
import { AgentErrorCode } from "../errors/agent.error-codes";
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
 */
@Injectable()
export class RemoteAgentsService {
  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
  ) {}

  /** 列出同账号其他设备上已注册的远程 Agent（含宿主设备名 + 在线态）。 */
  async listRemoteAgents(): Promise<RemoteAgentView[]> {
    const token = await this.token();
    const [agents, devices] = await Promise.all([
      this.cloud.get<CloudAgentSummary[]>("/api/agents", token),
      this.cloud.get<DeviceView[]>("/api/devices", token),
    ]);
    const currentDeviceId = devices.find((d) => d.isCurrent)?.id ?? null;
    const deviceNameById = new Map(devices.map((d) => [d.id, d.name]));
    const remote = agents.filter((a) => a.deviceId !== currentDeviceId);
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
