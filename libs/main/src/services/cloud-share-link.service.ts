import { randomBytes } from "node:crypto";
import { AppError } from "@meshbot/common";
import { AssetService } from "@meshbot/assets";
import * as bcrypt from "bcrypt";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, type Repository } from "typeorm";

import { CloudShareLink } from "../entities/cloud-share-link.entity";
import type { CloudNode } from "../entities/cloud-node.entity";
import { MainErrorCode } from "../errors/main.error-codes";
import { CloudNodeService } from "./cloud-node.service";

const BCRYPT_COST = 12;
const SHARE_TTL = 3600;

type Ctx = { userId: string };

/** 网盘文件公开分享短链服务。CloudShareLink 的唯一归属 Service（check:repo）。 */
@Injectable()
export class CloudShareLinkService {
  constructor(
    @InjectRepository(CloudShareLink)
    private readonly repo: Repository<CloudShareLink>,
    private readonly node: CloudNodeService,
    private readonly assets: AssetService,
  ) {}

  /**
   * owner 为单文件创建公开链接。
   * 单表写，不挂 @Transactional。
   */
  async create(
    ctx: Ctx,
    nodeId: string,
    opts: { expiresInDays?: number | null; password?: string },
  ): Promise<CloudShareLink> {
    const n = await this.node.findById(nodeId);

    if (!n || n.status !== "ready" || n.type !== "file") {
      throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
    }

    if (n.ownerUserId !== ctx.userId) {
      throw new AppError(MainErrorCode.DRIVE_FORBIDDEN);
    }

    const passwordHash = opts.password
      ? await bcrypt.hash(opts.password, BCRYPT_COST)
      : null;
    const expiresAt = opts.expiresInDays
      ? new Date(Date.now() + opts.expiresInDays * 86_400_000)
      : null;

    const link = this.repo.create({
      token: randomBytes(9).toString("base64url"),
      nodeId,
      orgId: n.orgId,
      createdByUserId: ctx.userId,
      passwordHash,
      expiresAt,
      revokedAt: null,
    });

    return this.repo.save(link);
  }

  /**
   * 解析公开 token，无效/撤销/过期/节点失效则抛。
   * 无鉴权（token 本身即凭证）。
   */
  async resolveOrThrow(
    token: string,
  ): Promise<{ link: CloudShareLink; node: CloudNode }> {
    const link = await this.repo.findOne({ where: { token } });

    if (!link || link.revokedAt) {
      throw new AppError(MainErrorCode.DRIVE_SHARE_NOT_FOUND);
    }

    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
      throw new AppError(MainErrorCode.DRIVE_SHARE_EXPIRED);
    }

    const node = await this.node.findById(link.nodeId);

    if (!node || node.status !== "ready") {
      throw new AppError(MainErrorCode.DRIVE_SHARE_NOT_FOUND);
    }

    return { link, node };
  }

  /**
   * 校验链接密码。无密码链接恒返回 true。
   */
  async verifyPassword(
    link: CloudShareLink,
    password?: string,
  ): Promise<boolean> {
    if (!link.passwordHash) return true;
    if (!password) return false;
    return bcrypt.compare(password, link.passwordHash);
  }

  /**
   * 生成下载 presigned URL（token 已是凭证，绕 ACL）。
   */
  async signDownload(
    node: CloudNode,
  ): Promise<{ url: string; name: string; mime: string }> {
    const url = await this.assets.getSignedUrl(node.assetKey ?? "", SHARE_TTL);
    return { url, name: node.name, mime: node.mime ?? "" };
  }

  /**
   * 列出某文件未撤销的链接（仅 owner）。
   */
  async listForNode(ctx: Ctx, nodeId: string): Promise<CloudShareLink[]> {
    const n = await this.node.findById(nodeId);

    if (!n || n.ownerUserId !== ctx.userId) {
      throw new AppError(MainErrorCode.DRIVE_FORBIDDEN);
    }

    return this.repo.find({
      where: { nodeId, revokedAt: IsNull() },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * 软删撤销分享链接（仅 owner）。
   * 单表写，不挂 @Transactional。
   */
  async revoke(ctx: Ctx, linkId: string): Promise<void> {
    const link = await this.repo.findOne({ where: { id: linkId } });

    if (!link) {
      throw new AppError(MainErrorCode.DRIVE_SHARE_NOT_FOUND);
    }

    const n = await this.node.findById(link.nodeId);

    if (!n || n.ownerUserId !== ctx.userId) {
      throw new AppError(MainErrorCode.DRIVE_FORBIDDEN);
    }

    await this.repo.update({ id: linkId }, { revokedAt: new Date() });
  }
}
