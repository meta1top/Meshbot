import {
  AccountContextService,
  CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
} from "@meshbot/lib-agent";
import type { AgentModelConfig } from "@meshbot/types";
import {
  MODEL_CONFIG_EVENTS,
  type ModelConfigUpdatedEvent,
} from "@meshbot/types-agent";
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { ACCOUNT_EVENTS } from "../account/account.events";
import type { AccountRuntimeEvent } from "../account/account.events";
import { CloudClientService } from "../cloud/cloud-client.service";
import { AUTH_EVENTS, type AuthorizedEvent } from "./auth.events";
import {
  IM_RELAY_EVENTS,
  type ImRelayConnectedEvent,
  type ImRelayModelConfigChangedEvent,
} from "../cloud/im-relay.events";
import { CloudIdentityService } from "./cloud-identity.service";
import type { CloudModelConfigRow } from "./model-config.service";
import { ModelConfigService } from "./model-config.service";

/**
 * 云端组织模型配置同步服务——事件驱动，无轮询：
 * - 启动 / 登录（runtimeCreated）同步一次；
 * - relay WS（重）连成功同步一次（离线期间的变更在重连瞬间追平）；
 * - 云端广播 modelConfigChanged（org 内模型创建/编辑/启禁/删除）实时同步。
 * 覆盖性：设备任意时刻要么在线（收广播）要么刚上线（重连拉取），无漏更新窗口。
 * 同步完成后发 MODEL_CONFIG_EVENTS.updated（ws/events 信封转前端刷新列表）。
 */
@Injectable()
export class ModelConfigSyncService implements OnApplicationBootstrap {
  /** 按账号连续失败计数——仅用于告警日志分级（轮询退避已随轮询一并移除）。 */
  private readonly failCounts = new Map<string, number>();
  private readonly logger = new Logger(ModelConfigSyncService.name);

  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
    private readonly modelConfig: ModelConfigService,
    private readonly config: ConfigService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** 启动时对全部已登录账号逐个同步一次。 */
  async onApplicationBootstrap(): Promise<void> {
    const identities = await this.identity.listLoggedIn();
    for (const id of identities) await this.syncNow(id.cloudUserId);
  }

  /**
   * 设备授权完成（登录）：complete() 用 emitAsync 等待本监听器——
   * 首次模型同步在登录响应返回前完成，桌面端落地即有模型列表。
   */
  @OnEvent(AUTH_EVENTS.authorized)
  async onAuthorized({ cloudUserId }: AuthorizedEvent): Promise<void> {
    await this.syncNow(cloudUserId);
  }

  /** relay WS（重）连成功：追平离线期间的云端模型变更。 */
  @OnEvent(IM_RELAY_EVENTS.connected)
  async onRelayConnected({
    cloudUserId,
  }: ImRelayConnectedEvent): Promise<void> {
    await this.syncNow(cloudUserId);
  }

  /** 云端广播模型配置变更（失效信号）：实时全量重同步。 */
  @OnEvent(IM_RELAY_EVENTS.modelConfigChanged)
  async onModelConfigChanged({
    cloudUserId,
  }: ImRelayModelConfigChangedEvent): Promise<void> {
    await this.syncNow(cloudUserId);
  }

  /** 账号运行时创建（登录 / 重连）时立即同步一次该账号的模型配置。 */
  @OnEvent(ACCOUNT_EVENTS.runtimeCreated)
  async onRuntimeCreated({ cloudUserId }: AccountRuntimeEvent): Promise<void> {
    await this.syncNow(cloudUserId);
  }

  /** 账号运行时销毁（登出）时清理该账号的失败计数，防陈旧计数拖高退避。 */
  @OnEvent(ACCOUNT_EVENTS.runtimeTeardown)
  onRuntimeTeardown({ cloudUserId }: AccountRuntimeEvent): void {
    this.failCounts.delete(cloudUserId);
  }

  /** 拉取云端组织模型配置并整体替换本地 cloud 来源缓存；失败静默返回 false（仅告警日志）。 */
  async syncNow(cloudUserId: string): Promise<boolean> {
    try {
      const id = await this.identity.get(cloudUserId);
      if (!id?.deviceToken) return false;
      const configs = await this.cloud.get<AgentModelConfig[]>(
        "/api/agent/model-configs",
        id.deviceToken,
      );
      const rows = configs.map((c) => this.toGatewayRow(c));
      await this.account.run(cloudUserId, () =>
        this.modelConfig.replaceCloudConfigs(rows),
      );
      this.failCounts.delete(cloudUserId);
      // 通知前端刷新模型列表（EventsGateway 转 ws/events 信封到 acct 房间）
      this.emitter.emit(MODEL_CONFIG_EVENTS.updated, {
        cloudUserId,
      } satisfies ModelConfigUpdatedEvent);
      return true;
    } catch (err) {
      const count = (this.failCounts.get(cloudUserId) ?? 0) + 1;
      this.failCounts.set(cloudUserId, count);
      this.logger.warn(
        `模型配置同步失败（账号 ${cloudUserId} 连续第 ${count} 次）: ${String(err)}`,
      );
      return false;
    }
  }

  /**
   * 把云端下发的"可见列表" `AgentModelConfig` 映射为指向本地网关代理的
   * openai-compatible 坐标行：`model` 用云端配置 id 做调用引用，真实
   * provider/model 名与厂商 apiKey 只在云端网关内部解密持有，本地不落地
   * 明文（`apiKey` 写占位符，libs/agent 的 `createChatModel` 用 fetch
   * 包装在请求时注入真实 device token，见 `buildCloudFetch`）。
   */
  private toGatewayRow(config: AgentModelConfig): CloudModelConfigRow {
    const cloudUrl = this.config.getOrThrow<string>("MESHBOT_CLOUD_URL");
    return {
      // 本地行 id 复用云端配置 id：跨同步稳定，会话级模型引用不失效。
      id: config.id,
      providerType: "openai-compatible",
      baseUrl: `${cloudUrl.replace(/\/$/, "")}/api/v1`,
      model: config.id,
      apiKey: CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
      name: config.name,
      contextWindow: config.contextWindow,
      enabled: config.enabled,
    };
  }
}
