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
  /**
   * 按账号独立的连续失败计数（cloudUserId → 连败次数）。
   * 全局共享单计数会被健康账号每轮归零，持续故障账号的退避永远卡在低档位。
   */
  private readonly failCounts = new Map<string, number>();
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
      await this.account.run(cloudUserId, () =>
        this.modelConfig.replaceCloudConfigs(configs),
      );
      this.failCounts.delete(cloudUserId);
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

  /** 挂一次性定时器：到时对全部已登录账号同步，按结果决定下一次延迟（失败退避）。 */
  private schedule(delay: number): void {
    this.timer = setTimeout(async () => {
      const identities = await this.identity.listLoggedIn().catch(() => []);
      let roundOk = true;
      for (const id of identities) {
        roundOk = (await this.syncNow(id.cloudUserId)) && roundOk;
      }
      this.schedule(this.nextDelay(identities.length, roundOk));
    }, delay);
    this.timer.unref();
  }

  /**
   * 计算下一轮同步延迟：
   * - 无已登录账号 / 本轮全部成功 → 正常间隔 30 分钟（"无账号"不是失败路径，不得空转退避）
   * - 有失败 → 按各账号中最大的连败次数指数退避（首败 1 分钟，连败翻倍，封顶 30 分钟）
   */
  private nextDelay(identityCount: number, roundOk: boolean): number {
    if (identityCount === 0 || roundOk) return SYNC_INTERVAL_MS;
    const maxFail = Math.max(1, ...this.failCounts.values());
    return Math.min(BACKOFF_BASE_MS * 2 ** (maxFail - 1), SYNC_INTERVAL_MS);
  }
}
