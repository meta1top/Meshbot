import {
  AccountContextService,
  CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
} from "@meshbot/lib-agent";
import type { AgentModelConfig } from "@meshbot/types";
import {
  MODEL_CONFIG_EVENTS,
  type ModelConfigUpdatedEvent,
} from "@meshbot/types-agent";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { CloudClientService } from "../cloud/cloud-client.service";
import {
  IM_RELAY_EVENTS,
  type ImRelayModelConfigChangedEvent,
} from "../cloud/im-relay.events";
import { ModelConfig } from "../entities/model-config.entity";
import { CloudIdentityService } from "./cloud-identity.service";

/** 云端模型列表内存缓存 TTL（毫秒），账号作用域（D3）。 */
const CACHE_TTL_MS = 45_000;
/** contextWindow 兜底值（与 entity 列默认一致），云端未给时使用。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 单账号缓存条目：取回时间戳 + 映射后的云端坐标行。 */
interface CacheEntry {
  at: number;
  rows: ModelConfig[];
}

/**
 * 云端组织模型配置读时代理（读时合并架构 A）。
 *
 * 用 device token 实时拉云端 `GET /api/agent/model-configs`，映射为指向本地
 * 网关的 openai-compatible 坐标行（`source='cloud'`，内存构造、绝不落库），
 * 供 ModelConfigService 合并读方法兜底。短 TTL 缓存（45s，key=cloudUserId）
 * 削打云端频次；云端广播 modelConfigChanged 时主动清缓存并通知前端刷新。
 * 云端不可达时返回空 cloud 列表（不抛、不缓存），本地模型不受影响（D1）。
 */
@Injectable()
export class CloudModelConfigProxyService {
  private readonly logger = new Logger(CloudModelConfigProxyService.name);
  /** 账号作用域缓存：cloudUserId → 云端坐标行 + 取回时间。 */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
    private readonly config: ConfigService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * 取当前账号的云端模型配置（映射为网关坐标行、打 source='cloud' 标）。
   * TTL 内命中缓存直接返回；过期/未命中打云端；云端不可达返回空、不抛。
   */
  async getCloudConfigs(): Promise<ModelConfig[]> {
    const cloudUserId = this.account.getOrThrow();
    const cached = this.cache.get(cloudUserId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows;

    const id = await this.identity.get(cloudUserId);
    if (!id?.deviceToken) return [];
    try {
      const configs = await this.cloud.get<AgentModelConfig[]>(
        "/api/agent/model-configs",
        id.deviceToken,
      );
      const rows = configs.map((c) => this.toGatewayRow(c, cloudUserId));
      this.cache.set(cloudUserId, { at: Date.now(), rows });
      return rows;
    } catch (err) {
      this.logger.warn(
        `云端模型配置代理失败（账号 ${cloudUserId}）: ${String(err)}`,
      );
      return [];
    }
  }

  /**
   * 云端广播模型配置变更（失效信号）：清该账号缓存 + emit 前端刷新事件。
   * 语义从旧 sync 的「重新同步落库」改为「清缓存」——下次读实时取云端。
   */
  @OnEvent(IM_RELAY_EVENTS.modelConfigChanged)
  onModelConfigChanged({ cloudUserId }: ImRelayModelConfigChangedEvent): void {
    this.cache.delete(cloudUserId);
    this.emitter.emit(MODEL_CONFIG_EVENTS.updated, {
      cloudUserId,
    } satisfies ModelConfigUpdatedEvent);
  }

  /**
   * 把云端「可见列表」`AgentModelConfig` 映射为指向本地网关的 openai-compatible
   * 坐标行：`model` 用云端配置 id 做调用引用，`apiKey` 是占位符（真实厂商 key
   * 只在云端网关持有），`source='cloud'`、内存构造不落库。
   */
  private toGatewayRow(
    config: AgentModelConfig,
    cloudUserId: string,
  ): ModelConfig {
    const cloudUrl = this.config.getOrThrow<string>("MESHBOT_CLOUD_URL");
    return {
      id: config.id,
      cloudUserId,
      providerType: "openai-compatible",
      baseUrl: `${cloudUrl.replace(/\/$/, "")}/api/v1`,
      model: config.id,
      apiKey: CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
      name: config.name,
      contextWindow: config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      enabled: config.enabled,
      source: "cloud",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as ModelConfig;
  }
}
