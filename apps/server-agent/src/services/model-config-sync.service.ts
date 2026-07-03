import { AccountContextService } from "@meshbot/agent";
import type { AgentModelConfig } from "@meshbot/types";
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ACCOUNT_EVENTS } from "../account/account.events";
import type { AccountRuntimeEvent } from "../account/account.events";
import { CloudClientService } from "../cloud/cloud-client.service";
import { CloudIdentityService } from "./cloud-identity.service";
import { ModelConfigService } from "./model-config.service";

/** 定时全量同步周期：30 分钟。 */
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
/** 失败退避基数：1 分钟起，指数翻倍，封顶到 SYNC_INTERVAL_MS。 */
const BACKOFF_BASE_MS = 60 * 1000;

/**
 * 云端组织模型配置同步服务——登录 / 启动 / 定时从云端拉组织模型配置，
 * 整体替换本地 source='cloud' 缓存行（本地模型配置写 REST 已下线）。
 */
@Injectable()
export class ModelConfigSyncService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private failCount = 0;
  private readonly logger = new Logger(ModelConfigSyncService.name);

  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
    private readonly modelConfig: ModelConfigService,
  ) {}

  /** 启动时对全部已登录账号逐个同步一次，随后挂定时器。 */
  async onApplicationBootstrap(): Promise<void> {
    const identities = await this.identity.listLoggedIn();
    for (const id of identities) await this.syncNow(id.cloudUserId);
    this.schedule(SYNC_INTERVAL_MS);
  }

  /** 模块销毁时清定时器，避免测试 / 热重载残留定时任务。 */
  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** 账号运行时创建（登录 / 重连）时立即同步一次该账号的模型配置。 */
  @OnEvent(ACCOUNT_EVENTS.runtimeCreated)
  async onRuntimeCreated({ cloudUserId }: AccountRuntimeEvent): Promise<void> {
    await this.syncNow(cloudUserId);
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
      await this.account.run(cloudUserId, () =>
        this.modelConfig.replaceCloudConfigs(configs),
      );
      this.failCount = 0;
      return true;
    } catch (err) {
      this.failCount += 1;
      this.logger.warn(
        `模型配置同步失败（第 ${this.failCount} 次）: ${String(err)}`,
      );
      return false;
    }
  }

  /** 挂一次性定时器：到时对全部已登录账号同步，按结果决定下一次延迟（失败退避）。 */
  private schedule(delay: number): void {
    this.timer = setTimeout(async () => {
      const identities = await this.identity.listLoggedIn().catch(() => []);
      let allOk = identities.length > 0;
      for (const id of identities) {
        allOk = (await this.syncNow(id.cloudUserId)) && allOk;
      }
      const backoff = allOk
        ? SYNC_INTERVAL_MS
        : Math.min(BACKOFF_BASE_MS * 2 ** this.failCount, SYNC_INTERVAL_MS);
      this.schedule(backoff);
    }, delay);
    this.timer.unref();
  }
}
