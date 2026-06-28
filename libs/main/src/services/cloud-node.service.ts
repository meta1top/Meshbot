import { Transactional } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, LessThan, type Repository } from "typeorm";
import { CloudNode } from "../entities/cloud-node.entity";

/**
 * CloudNode 的唯一归属 Service（check:repo）。
 * 负责网盘节点（文件/文件夹）的 CRUD，不含业务编排逻辑。
 * bigint 列（sizeBytes）在 Postgres 读出为 string，统一用 Number() 转换。
 */
@Injectable()
export class CloudNodeService {
  constructor(
    @InjectRepository(CloudNode)
    private readonly repo: Repository<CloudNode>,
  ) {}

  /**
   * 列出目录下所有子节点（仅 status='ready'）。
   * parentId 为 null 表示根目录。
   */
  async listChildren(
    orgId: string,
    parentId: string | null,
  ): Promise<CloudNode[]> {
    return this.repo.find({
      where: {
        orgId,
        parentId: parentId === null ? IsNull() : parentId,
        status: "ready",
      },
      order: { type: "ASC", name: "ASC" },
    });
  }

  /** 按 id 查找节点，不存在返回 null。 */
  async findById(id: string): Promise<CloudNode | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * 沿 parentId 链向上收集祖先节点（不含自身）。
   * 返回顺序从直接父节点到根节点。
   */
  async listAncestors(node: CloudNode): Promise<CloudNode[]> {
    const out: CloudNode[] = [];
    let cur = node.parentId;
    while (cur) {
      const p = await this.repo.findOne({ where: { id: cur } });
      if (!p) break;
      out.push(p);
      cur = p.parentId;
    }
    return out;
  }

  /**
   * 创建文件夹节点，status='ready'，type='folder'。
   */
  async createFolderRow(
    orgId: string,
    ownerUserId: string,
    parentId: string | null,
    name: string,
  ): Promise<CloudNode> {
    const node = this.repo.create({
      orgId,
      ownerUserId,
      parentId: parentId ?? null,
      type: "folder",
      name,
      status: "ready",
      mime: null,
      assetKey: null,
      sizeBytes: 0,
    });
    return this.repo.save(node);
  }

  /**
   * 创建文件上传占位行，status='uploading'，type='file'。
   * 先 create+save 触发 @BeforeInsert 生成雪花 id，再用 id 计算 assetKey 并更新。
   * 注意：不能用 plain-object save 或 .insert()，否则 id 为 NULL。
   * 两步写入同一行，挂 @Transactional() 保证原子性。
   */
  @Transactional()
  async createUploadingRow(
    orgId: string,
    ownerUserId: string,
    parentId: string | null,
    name: string,
    mime: string,
  ): Promise<CloudNode> {
    // Step 1: 先 create+save 触发 @BeforeInsert 生成雪花 id
    const node = this.repo.create({
      orgId,
      ownerUserId,
      parentId: parentId ?? null,
      type: "file",
      name,
      mime,
      status: "uploading",
      assetKey: null,
      sizeBytes: 0,
    });
    const saved = await this.repo.save(node);

    // Step 2: 拿到 id 后算 assetKey 并 update
    const assetKey = `drive/${orgId}/${saved.id}`;
    await this.repo.update(saved.id, { assetKey });

    // Step 3: 返回含 assetKey 的最新节点
    return this.repo.findOne({ where: { id: saved.id } }) as Promise<CloudNode>;
  }

  /**
   * 将节点标记为 ready，设置 sizeBytes 和 checksum。
   */
  async markReady(
    id: string,
    sizeBytes: number,
    checksum: string,
  ): Promise<void> {
    await this.repo.update(id, { status: "ready", sizeBytes, checksum });
  }

  /** 重命名节点。 */
  async rename(id: string, name: string): Promise<void> {
    await this.repo.update(id, { name });
  }

  /** 移动节点到新父目录。 */
  async move(id: string, parentId: string | null): Promise<void> {
    await this.repo.update(id, { parentId: parentId ?? undefined });
  }

  /**
   * 删除单个节点（递归删除由编排层负责）。
   */
  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  /**
   * 检查同目录下是否存在同名节点（不区分类型）。
   */
  async nameExists(
    orgId: string,
    parentId: string | null,
    name: string,
  ): Promise<boolean> {
    const count = await this.repo.count({
      where: {
        orgId,
        parentId: parentId === null ? IsNull() : parentId,
        name,
      },
    });
    return count > 0;
  }

  /**
   * 统计 org 已用空间（status='ready' 且 type='file' 的 sizeBytes 之和）。
   * Postgres 读出 bigint 为 string，统一 Number() 转换。
   */
  async sumOrgReadySize(orgId: string): Promise<number> {
    const row = await this.repo
      .createQueryBuilder("n")
      .select("COALESCE(SUM(n.sizeBytes), 0)", "total")
      .where("n.orgId = :orgId AND n.type = 'file' AND n.status = 'ready'", {
        orgId,
      })
      .getRawOne<{ total: string | number }>();
    return Number(row?.total ?? 0);
  }

  /**
   * 列出早于指定时间戳（毫秒）且 status='uploading' 的节点（用于清理僵尸上传）。
   */
  async listStaleUploading(beforeMs: number): Promise<CloudNode[]> {
    return this.repo.find({
      where: {
        status: "uploading",
        createdAt: LessThan(new Date(beforeMs)),
      },
    });
  }
}
