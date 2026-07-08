import { AppError, CommonErrorCode } from "@meshbot/common";
import type {
  AgentModelConfig,
  OrgModelConfigInput,
  OrgModelConfigView,
} from "@meshbot/types";
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { OrgModelConfig } from "../entities/org-model-config.entity";
import { SecretCryptoService } from "./secret-crypto.service";

/** 网关内部解析结果:归属校验通过后的厂商真实调用参数(apiKey 已解密明文) */
export interface ResolvedModel {
  providerType: string;
  model: string;
  baseUrl: string | null;
  apiKey: string;
  contextWindow: number | null;
}

/** 组织级模型配置归属 Service;写侧仅 owner(controller 断言),apiKey 加密存储 */
@Injectable()
export class OrgModelConfigService {
  private readonly logger = new Logger(OrgModelConfigService.name);

  constructor(
    @InjectRepository(OrgModelConfig)
    private readonly configRepo: Repository<OrgModelConfig>,
    private readonly crypto: SecretCryptoService,
  ) {}

  /** 管理端列表(apiKey 打码) */
  async listForAdmin(orgId: string): Promise<OrgModelConfigView[]> {
    const rows = await this.configRepo.find({ where: { orgId } });
    return rows.map((r) => this.toView(r));
  }

  /** 新建配置 */
  async create(
    orgId: string,
    input: OrgModelConfigInput,
  ): Promise<OrgModelConfigView> {
    if (!input.apiKey) throw new AppError(CommonErrorCode.VALIDATION_FAILED);
    const row = await this.configRepo.save(
      this.configRepo.create({
        orgId,
        name: input.name,
        providerType: input.providerType,
        model: input.model,
        apiKeyEnc: this.crypto.encrypt(input.apiKey),
        baseUrl: input.baseUrl ?? "",
        contextWindow: input.contextWindow ?? 128_000,
        enabled: input.enabled ?? true,
      }),
    );
    return this.toView(row);
  }

  /** 更新配置;apiKey 缺省表示不换 */
  async update(
    orgId: string,
    id: string,
    input: Partial<OrgModelConfigInput>,
  ): Promise<OrgModelConfigView> {
    const row = await this.findOwned(orgId, id);
    if (input.name !== undefined) row.name = input.name;
    if (input.providerType !== undefined) row.providerType = input.providerType;
    if (input.model !== undefined) row.model = input.model;
    if (input.baseUrl !== undefined) row.baseUrl = input.baseUrl;
    if (input.contextWindow !== undefined)
      row.contextWindow = input.contextWindow;
    if (input.enabled !== undefined) row.enabled = input.enabled;
    if (input.apiKey) row.apiKeyEnc = this.crypto.encrypt(input.apiKey);
    return this.toView(await this.configRepo.save(row));
  }

  /** 删除配置 */
  async remove(orgId: string, id: string): Promise<void> {
    await this.findOwned(orgId, id);
    await this.configRepo.delete({ id });
  }

  /** Agent 下发:解密、仅 enabled */
  async listForAgent(orgId: string): Promise<AgentModelConfig[]> {
    const rows = await this.configRepo.find({ where: { orgId } });
    return rows
      .filter((r) => r.enabled)
      .map((r) => ({
        id: r.id,
        providerType: r.providerType,
        name: r.name,
        model: r.model,
        apiKey: this.crypto.decrypt(r.apiKeyEnc),
        baseUrl: r.baseUrl,
        contextWindow: r.contextWindow,
        enabled: r.enabled,
      }));
  }

  /** 网关内部用:按 orgId + 模型 id 查归属并解密厂商 apiKey;不存在/不归属返回 null */
  async resolveDecrypted(
    orgId: string,
    modelId: string,
  ): Promise<ResolvedModel | null> {
    const row = await this.configRepo.findOne({
      where: { id: modelId, orgId, enabled: true },
    });
    if (!row) return null;
    return {
      providerType: row.providerType,
      model: row.model,
      baseUrl: row.baseUrl ?? null,
      apiKey: this.crypto.decrypt(row.apiKeyEnc),
      contextWindow: row.contextWindow ?? null,
    };
  }

  private async findOwned(orgId: string, id: string): Promise<OrgModelConfig> {
    const row = await this.configRepo.findOne({ where: { id, orgId } });
    if (!row) throw new AppError(CommonErrorCode.NOT_FOUND);
    return row;
  }

  private toView(r: OrgModelConfig): OrgModelConfigView {
    const tail = (() => {
      try {
        return this.crypto.decrypt(r.apiKeyEnc).slice(-4);
      } catch {
        this.logger.warn(
          `模型配置 ${r.id}(org ${r.orgId})apiKey 解密失败,可能密钥轮换或数据损坏`,
        );
        return "????";
      }
    })();
    return {
      id: r.id,
      orgId: r.orgId,
      name: r.name,
      providerType: r.providerType,
      model: r.model,
      apiKeyMasked: `****${tail}`,
      baseUrl: r.baseUrl,
      contextWindow: r.contextWindow,
      enabled: r.enabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
