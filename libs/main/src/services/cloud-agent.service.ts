import type { AgentSyncInput } from "@meshbot/types-main";
import { Injectable, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, type Repository } from "typeorm";
import { CloudAgent } from "../entities/cloud-agent.entity";

/** 云端 Agent 注册表变更事件（对账产生实际写入）：im.gateway 监听后向该用户广播。 */
export const CLOUD_AGENT_EVENTS = {
  changed: "cloud-agent.changed",
} as const;
export interface CloudAgentChangedEvent {
  userId: string;
  orgId: string | null;
}

/**
 * CloudAgent 的唯一归属 Service（check:repo）。
 * 负责云端 Agent 注册表的全量对账（设备侧 remote_enabled Agent 元数据镜像）。
 */
@Injectable()
export class CloudAgentService {
  constructor(
    @InjectRepository(CloudAgent)
    private readonly agentRepo: Repository<CloudAgent>,
    // @Optional：生产由全局 EventEmitterModule 注入；单测单参构造仍可用。
    @Optional() private readonly emitter?: EventEmitter2,
  ) {}

  /** 对账产生实际写入后发进程内事件（im.gateway 监听 → 定向广播给该用户）。 */
  private emitChanged(userId: string, orgId: string | null): void {
    this.emitter?.emit(CLOUD_AGENT_EVENTS.changed, {
      userId,
      orgId,
    } satisfies CloudAgentChangedEvent);
  }

  /**
   * 设备侧全量推送 remote_enabled agent 列表，按 (deviceId, localAgentId) 对账：
   * 存在的 upsert（更新元数据 + 复活软删行）、列表里消失的软删、新的 insert。
   *
   * 关键约束：同一 localAgentId 永远复用同一行、同一个云端 id ——
   * 云端 agent.id 是 T5 网关寻址的主键，**不能**先删后插（那样 id 会漂移，
   * 已寻址的 agent 会失效）。故用 upsert + 软删，绝不硬删已存在的行。
   *
   * 无需 @Transactional：从头到尾只写 `agent` 一张表，末尾单次
   * `this.agentRepo.save(rows)`——`save(array)` 本身即在单个事务内原子提交，
   * 不需要再额外包一层事务（CLAUDE.md：单表 upsert/update 不需要 @Transactional）。
   *
   * 防御：入参 items 若同一 localAgentId 出现多次（调用方 bug/竞态），只保留
   * 批次内最后一条，避免各自建行时并发写入同一行导致撞
   * `uq_agent_device_local` 唯一索引裸抛 Postgres 异常。
   */
  async syncForDevice(
    deviceId: string,
    userId: string,
    orgId: string | null,
    items: AgentSyncInput[],
  ): Promise<void> {
    const dedupedByLocalId = new Map(items.map((i) => [i.localAgentId, i]));

    const existing = await this.agentRepo.find({ where: { deviceId } });
    const byLocalId = new Map(existing.map((e) => [e.localAgentId, e]));
    const now = new Date();
    const rows: CloudAgent[] = [];

    for (const i of dedupedByLocalId.values()) {
      const row =
        byLocalId.get(i.localAgentId) ??
        this.agentRepo.create({ deviceId, localAgentId: i.localAgentId });
      row.userId = userId;
      row.orgId = orgId;
      row.name = i.name;
      row.avatar = i.avatar;
      row.description = i.description;
      row.visibility = i.visibility;
      row.lastSyncedAt = now;
      row.deletedAt = null; // 复活软删行
      rows.push(row);
    }

    const gone = existing.filter(
      (e) => !dedupedByLocalId.has(e.localAgentId) && e.deletedAt === null,
    );
    for (const g of gone) {
      g.deletedAt = now;
      rows.push(g);
    }

    if (rows.length > 0) {
      await this.agentRepo.save(rows);
      // 只有实际发生写入（新增/改名/复活/软删）才广播，避免空跑一次全量推送
      // 也触发前端刷新（web-main 实时性修复：关/开「允许远程」后列表免手动刷新）。
      this.emitChanged(userId, orgId);
    }
  }

  /** web-main 列当前用户的已注册（未软删）远程 Agent。 */
  listForUser(userId: string): Promise<CloudAgent[]> {
    return this.agentRepo.find({
      where: { userId, deletedAt: IsNull() },
      order: { createdAt: "ASC" },
    });
  }

  /** 网关寻址：按云端 agent id 查未软删的行（T5 用）。 */
  findActiveById(id: string): Promise<CloudAgent | null> {
    return this.agentRepo.findOne({ where: { id, deletedAt: IsNull() } });
  }
}
