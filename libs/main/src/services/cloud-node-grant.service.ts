import { Transactional } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, type Repository } from "typeorm";
import { CloudNodeGrant } from "../entities/cloud-node-grant.entity";

/** replaceForNode 输入的单条授权描述。 */
interface GrantInput {
  granteeType: "org" | "user";
  granteeId: string;
  permission: "viewer" | "editor";
}

/**
 * CloudNodeGrant 的唯一归属 Service（check:repo）。
 * 负责网盘 ACL 授权记录的 CRUD，不含业务编排逻辑。
 */
@Injectable()
export class CloudNodeGrantService {
  constructor(
    @InjectRepository(CloudNodeGrant)
    private readonly repo: Repository<CloudNodeGrant>,
  ) {}

  /**
   * 批量按节点 ID 列表查询授权记录。
   * 用于权限继承链批量取 grant。
   */
  async listForNodes(nodeIds: string[]): Promise<CloudNodeGrant[]> {
    if (nodeIds.length === 0) return [];
    return this.repo.find({ where: { nodeId: In(nodeIds) } });
  }

  /** 查询单个节点的所有授权记录。 */
  async listForNode(nodeId: string): Promise<CloudNodeGrant[]> {
    return this.repo.find({ where: { nodeId } });
  }

  /**
   * 替换节点的全部授权：先删除旧记录，再批量插入新记录。
   * 两步写入同表，挂 @Transactional() 保证原子性（delete+save 不会撕裂）。
   */
  @Transactional()
  async replaceForNode(nodeId: string, grants: GrantInput[]): Promise<void> {
    // 先删除该节点的所有旧授权
    await this.repo.delete({ nodeId });

    // 再批量插入新授权
    if (grants.length > 0) {
      const entities = grants.map((g) =>
        this.repo.create({
          nodeId,
          granteeType: g.granteeType,
          granteeId: g.granteeId,
          permission: g.permission,
        }),
      );
      await this.repo.save(entities);
    }
  }

  /** 删除节点的所有授权记录（节点被删时清理）。 */
  async deleteForNode(nodeId: string): Promise<void> {
    await this.repo.delete({ nodeId });
  }

  /**
   * 查询被授权给指定被授权方（user 或 org）的所有 grant 记录。
   * 供 CloudDriveService.listShared 使用。
   */
  async listByGrantee(
    granteeType: "user" | "org",
    granteeId: string,
  ): Promise<CloudNodeGrant[]> {
    return this.repo.find({ where: { granteeType, granteeId } });
  }
}
