import { AppError } from "@meshbot/common";
import { AssetService } from "@meshbot/assets";
import { Injectable, Logger } from "@nestjs/common";
import type { CloudNode } from "../entities/cloud-node.entity";
import type { CloudNodeGrant } from "../entities/cloud-node-grant.entity";
import { MainErrorCode } from "../errors/main.error-codes";
import { CloudNodeGrantService } from "./cloud-node-grant.service";
import { CloudNodeService } from "./cloud-node.service";
import { resolvePermission, RANK } from "./drive-acl";
import type { DrivePermission } from "./drive-acl";

// TODO: 迁移到 config 注入（SP-C）
const DRIVE_ORG_QUOTA_BYTES = 5 * 1024 ** 3;
const DRIVE_UPLOAD_TTL = 3600;

/** 网盘节点视图（对外暴露类型）。 */
export interface NodeView {
  id: string;
  type: "file" | "folder";
  name: string;
  sizeBytes: number;
  mime: string | null;
  status: "uploading" | "ready";
  permission: DrivePermission;
  createdAt: Date;
  updatedAt: Date;
}

/** 将 CloudNode 映射为 NodeView。 */
function toNodeView(n: CloudNode, permission: DrivePermission): NodeView {
  return {
    id: n.id,
    type: n.type,
    name: n.name,
    sizeBytes: n.sizeBytes,
    mime: n.mime,
    status: n.status,
    permission,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

/**
 * 网盘编排服务（CloudDriveService）。
 * 编排 CloudNodeService + CloudNodeGrantService + AssetService，
 * 不直接注入 @InjectRepository（check:repo 约束）。
 */
@Injectable()
export class CloudDriveService {
  private readonly logger = new Logger(CloudDriveService.name);

  constructor(
    private readonly node: CloudNodeService,
    private readonly grant: CloudNodeGrantService,
    private readonly assets: AssetService,
  ) {}

  /**
   * 私有权限检查 helper：解析用户对目标节点的权限，不足则抛 DRIVE_FORBIDDEN。
   * 查 node 自身 + 全部祖先的 grant，调用 resolvePermission 得到有效权限。
   */
  private async requirePermission(
    ctx: { userId: string; orgId: string },
    targetNode: CloudNode,
    min: DrivePermission,
  ): Promise<DrivePermission> {
    const ancestors = await this.node.listAncestors(targetNode);
    const nodeIds = [targetNode.id, ...ancestors.map((a) => a.id)];
    const grants = await this.grant.listForNodes(nodeIds);
    const perm = resolvePermission(ctx, targetNode, grants);
    if (perm === null || RANK[perm] < RANK[min]) {
      throw new AppError(MainErrorCode.DRIVE_FORBIDDEN);
    }
    return perm;
  }

  /**
   * 列出目录子节点。
   * parentId 为 null 时只列 ownerUserId=ctx.userId 且 parentId=null 的根节点（用户私有根）。
   * parentId 非 null 时需要 viewer 权限才能列子节点。
   * 无权访问父节点时抛 DRIVE_FORBIDDEN。
   */
  async listNodes(
    ctx: { userId: string; orgId: string },
    parentId: string | null,
  ): Promise<NodeView[]> {
    if (parentId === null) {
      // 根目录：只列属于当前用户的根节点（ownerUserId = ctx.userId, parentId = null）
      const roots = await this.node.listChildren(ctx.orgId, null);
      return roots
        .filter((n) => n.ownerUserId === ctx.userId)
        .map((n) => toNodeView(n, "owner"));
    }
    // 非根：requirePermission + 列子节点 + 批量解析权限
    const parent = await this.node.findById(parentId);
    if (!parent) return [];
    await this.requirePermission(ctx, parent, "viewer");
    const children = await this.node.listChildren(ctx.orgId, parentId);
    const results: NodeView[] = [];
    for (const child of children) {
      const ancestors = await this.node.listAncestors(child);
      const nodeIds = [child.id, ...ancestors.map((a) => a.id)];
      const grants = await this.grant.listForNodes(nodeIds);
      const perm = resolvePermission(ctx, child, grants);
      if (perm === null) continue;
      results.push(toNodeView(child, perm));
    }
    return results;
  }

  /**
   * 列出被直接授权给当前用户或 org 的节点。
   * v1 简化：不做「最浅去重」（若祖先也被授权给我，子节点会重复出现）。
   * TODO(SP-C): 最浅去重 —— 过滤掉祖先链中已含本次授权节点的条目。
   */
  async listShared(ctx: {
    userId: string;
    orgId: string;
  }): Promise<NodeView[]> {
    this.logger.log(
      `listShared v1-simplified: no ancestor dedup (SP-C todo). userId=${ctx.userId} orgId=${ctx.orgId}`,
    );
    const [userGrants, orgGrants] = await Promise.all([
      this.grant.listByGrantee("user", ctx.userId),
      this.grant.listByGrantee("org", ctx.orgId),
    ]);
    const allGrants = [...userGrants, ...orgGrants];
    const nodeIds = [
      ...new Set(allGrants.map((g: CloudNodeGrant) => g.nodeId)),
    ];
    const nodes: NodeView[] = [];
    for (const nodeId of nodeIds) {
      const n = await this.node.findById(nodeId);
      if (!n) continue;
      const perm = resolvePermission(
        ctx,
        n,
        allGrants.filter((g: CloudNodeGrant) => g.nodeId === nodeId),
      );
      if (perm) nodes.push(toNodeView(n, perm));
    }
    return nodes;
  }

  /**
   * 查询 org 已用空间和配额上限。
   */
  async quota(ctx: {
    userId: string;
    orgId: string;
  }): Promise<{ used: number; limit: number }> {
    const used = await this.node.sumOrgReadySize(ctx.orgId);
    return { used, limit: DRIVE_ORG_QUOTA_BYTES };
  }

  /**
   * 创建文件夹。编辑权限检查 + 同名冲突检查。
   */
  async createFolder(
    ctx: { userId: string; orgId: string },
    parentId: string | null,
    name: string,
  ): Promise<NodeView> {
    if (parentId !== null) {
      const parent = await this.node.findById(parentId);
      if (!parent) throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
      await this.requirePermission(ctx, parent, "editor");
    }
    const exists = await this.node.nameExists(ctx.orgId, parentId, name);
    if (exists) throw new AppError(MainErrorCode.DRIVE_NAME_CONFLICT);
    const created = await this.node.createFolderRow(
      ctx.orgId,
      ctx.userId,
      parentId,
      name,
    );
    return toNodeView(created, "owner");
  }

  /**
   * 请求上传文件：预取 presigned PUT URL，在 Minio 创建占位 uploading 行。
   * 父目录需 editor 权限；预检配额（ready 已用 + size > DRIVE_ORG_QUOTA_BYTES）。
   */
  async requestUpload(
    ctx: { userId: string; orgId: string },
    input: {
      name: string;
      parentId: string | null;
      size: number;
      mime: string;
    },
  ): Promise<{ nodeId: string; putUrl: string }> {
    const { name, parentId, size, mime } = input;
    if (parentId !== null) {
      const parent = await this.node.findById(parentId);
      if (!parent) throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
      await this.requirePermission(ctx, parent, "editor");
    }
    const used = await this.node.sumOrgReadySize(ctx.orgId);
    if (used + size > DRIVE_ORG_QUOTA_BYTES) {
      throw new AppError(MainErrorCode.DRIVE_QUOTA_EXCEEDED);
    }
    const created = await this.node.createUploadingRow(
      ctx.orgId,
      ctx.userId,
      parentId,
      name,
      mime,
    );
    const assetKey = created.assetKey ?? `drive/${ctx.orgId}/${created.id}`;
    const putUrl = await this.assets.getUploadUrl(assetKey, DRIVE_UPLOAD_TTL);
    return { nodeId: created.id, putUrl };
  }

  /**
   * 确认上传完成：调 asset.stat 取真实 size，再次验证配额，标记节点为 ready。
   * 超配额时删除 Minio 对象 + 节点行，抛 DRIVE_QUOTA_EXCEEDED。
   */
  async completeUpload(
    ctx: { userId: string; orgId: string },
    nodeId: string,
    checksum?: string,
  ): Promise<NodeView> {
    const n = await this.node.findById(nodeId);
    if (!n || n.orgId !== ctx.orgId) {
      throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
    }
    if (n.status !== "uploading") {
      throw new AppError(MainErrorCode.DRIVE_NOT_READY);
    }
    const nodeAssetKey = n.assetKey ?? "";
    const statResult = await this.assets.stat(nodeAssetKey);
    const used = await this.node.sumOrgReadySize(ctx.orgId);
    if (used + statResult.size > DRIVE_ORG_QUOTA_BYTES) {
      // 先删 DB 行（主数据），再 best-effort 删 Minio 对象（GC 兜底）
      await this.node.delete(nodeId);
      await this.assets.delete(nodeAssetKey).catch(() => undefined);
      throw new AppError(MainErrorCode.DRIVE_QUOTA_EXCEEDED);
    }
    await this.node.markReady(nodeId, statResult.size, checksum ?? null);
    const updated = await this.node.findById(nodeId);
    if (!updated) throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
    return toNodeView(updated, "owner");
  }

  /**
   * 获取文件下载签名 URL。需要 viewer 权限；节点 status 必须为 ready。
   */
  async getDownloadUrl(
    ctx: { userId: string; orgId: string },
    id: string,
  ): Promise<{ url: string; ttl: number }> {
    const n = await this.node.findById(id);
    if (!n) throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
    await this.requirePermission(ctx, n, "viewer");
    if (n.status !== "ready") throw new AppError(MainErrorCode.DRIVE_NOT_READY);
    const url = await this.assets.getSignedUrl(
      n.assetKey ?? "",
      DRIVE_UPLOAD_TTL,
      {
        contentType: n.mime ?? undefined,
        fileName: n.name,
        disposition: "inline",
      },
    );
    return { url, ttl: DRIVE_UPLOAD_TTL };
  }

  /**
   * 重命名节点。需要 editor 权限；同目录下同名冲突抛 DRIVE_NAME_CONFLICT。
   */
  async rename(
    ctx: { userId: string; orgId: string },
    id: string,
    name: string,
  ): Promise<void> {
    const n = await this.node.findById(id);
    if (!n) throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
    await this.requirePermission(ctx, n, "editor");
    const exists = await this.node.nameExists(ctx.orgId, n.parentId, name);
    if (exists) throw new AppError(MainErrorCode.DRIVE_NAME_CONFLICT);
    await this.node.rename(id, name);
  }

  /**
   * 移动节点到新父目录。
   * 防环：目标父自身或其祖先链包含被移动节点 → DRIVE_INVALID_MOVE。
   */
  async move(
    ctx: { userId: string; orgId: string },
    id: string,
    newParentId: string | null,
  ): Promise<void> {
    const n = await this.node.findById(id);
    if (!n) throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
    await this.requirePermission(ctx, n, "editor");
    if (newParentId !== null) {
      if (newParentId === id)
        throw new AppError(MainErrorCode.DRIVE_INVALID_MOVE);
      const newParent = await this.node.findById(newParentId);
      if (!newParent) throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
      await this.requirePermission(ctx, newParent, "editor");
      const ancestors = await this.node.listAncestors(newParent);
      const isDescendant = ancestors.some((a) => a.id === id);
      if (isDescendant) throw new AppError(MainErrorCode.DRIVE_INVALID_MOVE);
    }
    await this.node.move(id, newParentId);
  }

  /**
   * 删除节点（及其子树）。需要 editor 权限。
   * 递归删除（含 grant 清理）由 CloudNodeService.deleteSubtreeInTx 负责，
   * 事务在持有 @InjectRepository(CloudNode) 的 CloudNodeService 上开启。
   * Minio 对象删除在事务外 best-effort 执行（失败由 GC 兜底）。
   */
  async deleteNode(
    ctx: { userId: string; orgId: string },
    id: string,
  ): Promise<void> {
    const n = await this.node.findById(id);
    if (!n) throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
    await this.requirePermission(ctx, n, "editor");
    // 事务内完成 DB 删除，返回需清理的 Minio assetKey 列表
    const assetKeys = await this.node.deleteSubtreeInTx(id);
    // 事务外 best-effort 删 Minio 对象（失败不影响 DB 一致性，GC 兜底）
    for (const key of assetKeys) {
      await this.assets.delete(key).catch(() => undefined);
    }
  }

  /**
   * 列出节点的授权记录。需要 viewer 权限。
   */
  async listGrants(
    ctx: { userId: string; orgId: string },
    id: string,
  ): Promise<CloudNodeGrant[]> {
    const n = await this.node.findById(id);
    if (!n) throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
    await this.requirePermission(ctx, n, "viewer");
    return this.grant.listForNode(id);
  }

  /**
   * 设置节点授权列表（全量覆盖）。需要 owner 权限。
   */
  async setGrants(
    ctx: { userId: string; orgId: string },
    id: string,
    grantsInput: {
      grants: Array<{
        granteeType: "org" | "user";
        granteeId: string;
        permission: "viewer" | "editor";
      }>;
    },
  ): Promise<void> {
    const n = await this.node.findById(id);
    if (!n) throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
    await this.requirePermission(ctx, n, "owner");
    await this.grant.replaceForNode(id, grantsInput.grants);
  }
}
