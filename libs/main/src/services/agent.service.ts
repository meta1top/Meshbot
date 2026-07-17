import { Transactional } from "@meshbot/common";
import type { AgentSyncInput } from "@meshbot/types-main";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, type Repository } from "typeorm";
import { Agent } from "../entities/agent.entity";

/**
 * Agent 的唯一归属 Service（check:repo）。
 * 负责云端 Agent 注册表的全量对账（设备侧 remote_enabled Agent 元数据镜像）。
 */
@Injectable()
export class AgentService {
  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
  ) {}

  /**
   * 设备侧全量推送 remote_enabled agent 列表，按 (deviceId, localAgentId) 对账：
   * 存在的 upsert（更新元数据 + 复活软删行）、列表里消失的软删、新的 insert。
   *
   * 关键约束：同一 localAgentId 永远复用同一行、同一个云端 id ——
   * 云端 agent.id 是 T5 网关寻址的主键，**不能**先删后插（那样 id 会漂移，
   * 已寻址的 agent 会失效）。故用 upsert + 软删，绝不硬删已存在的行。
   *
   * tx-check: ignore —— 静态围栏按调用点数计数，只看到末尾一处
   * `this.agentRepo.save(rows)`；但 rows 是本次对账批量攒出的多行（upsert
   * 存量/新增 + 软删消失项），一次 save(array) 底层是多条 INSERT/UPDATE，
   * 必须原子提交（否则半途失败会留下部分行已改、部分未改的脏对账状态），
   * 事务并非多余。
   */
  @Transactional()
  async syncForDeviceInTx(
    deviceId: string,
    userId: string,
    orgId: string | null,
    items: AgentSyncInput[],
  ): Promise<void> {
    const existing = await this.agentRepo.find({ where: { deviceId } });
    const byLocalId = new Map(existing.map((e) => [e.localAgentId, e]));
    const incoming = new Set(items.map((i) => i.localAgentId));
    const now = new Date();
    const rows: Agent[] = [];

    for (const i of items) {
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
      (e) => !incoming.has(e.localAgentId) && e.deletedAt === null,
    );
    for (const g of gone) {
      g.deletedAt = now;
      rows.push(g);
    }

    if (rows.length > 0) await this.agentRepo.save(rows);
  }

  /** web-main 列当前用户的已注册（未软删）远程 Agent。 */
  listForUser(userId: string): Promise<Agent[]> {
    return this.agentRepo.find({
      where: { userId, deletedAt: IsNull() },
      order: { createdAt: "ASC" },
    });
  }

  /** 网关寻址：按云端 agent id 查未软删的行（T5 用）。 */
  findActiveById(id: string): Promise<Agent | null> {
    return this.agentRepo.findOne({ where: { id, deletedAt: IsNull() } });
  }
}
