import {
  CloudDriveService,
  CompleteUploadDto,
  CreateFolderDto,
  RenameOrMoveDto,
  RequestUploadDto,
  SetGrantsDto,
} from "@meshbot/main";
import { AppError } from "@meshbot/common";
import { MainErrorCode } from "@meshbot/main";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";

/**
 * 网盘 REST 端点（/api/drive）。
 * 全局 JwtAuthGuard 保护，无 @Public()。
 * Controller 只做请求接收与响应委派，业务在 CloudDriveService。
 */
@Controller("drive")
export class DriveController {
  constructor(private readonly drive: CloudDriveService) {}

  /**
   * 从 JWT payload 提取 ctx，orgId 缺失时抛 ORG_NOT_FOUND。
   */
  private ctx(user: JwtMainPayload): { userId: string; orgId: string } {
    if (!user.orgId) throw new AppError(MainErrorCode.ORG_NOT_FOUND);
    return { userId: user.userId, orgId: user.orgId };
  }

  /** 列出目录节点。parentId 为 null 时列根目录（仅自己的节点）。 */
  @Get("nodes")
  listNodes(
    @CurrentUser() u: JwtMainPayload,
    @Query("parentId") parentId?: string,
  ) {
    return this.drive.listNodes(this.ctx(u), parentId ?? null);
  }

  /** 列出被授权给当前用户的共享节点。 */
  @Get("shared")
  listShared(@CurrentUser() u: JwtMainPayload) {
    return this.drive.listShared(this.ctx(u));
  }

  /** 查询 org 网盘配额使用情况。 */
  @Get("quota")
  quota(@CurrentUser() u: JwtMainPayload) {
    return this.drive.quota(this.ctx(u));
  }

  /** 创建文件夹。 */
  @Post("folders")
  createFolder(@CurrentUser() u: JwtMainPayload, @Body() dto: CreateFolderDto) {
    return this.drive.createFolder(this.ctx(u), dto.parentId, dto.name);
  }

  /** 请求上传：返回预签名 PUT URL + nodeId（节点为 uploading 状态）。 */
  @Post("uploads")
  requestUpload(
    @CurrentUser() u: JwtMainPayload,
    @Body() dto: RequestUploadDto,
  ) {
    return this.drive.requestUpload(this.ctx(u), dto);
  }

  /** 确认上传完成：stat 真实 size + 二次配额检查 + 标记 ready。 */
  @Post("uploads/:nodeId/complete")
  @HttpCode(200)
  completeUpload(
    @CurrentUser() u: JwtMainPayload,
    @Param("nodeId") nodeId: string,
    @Body() dto: CompleteUploadDto,
  ) {
    return this.drive.completeUpload(this.ctx(u), nodeId, dto.checksum);
  }

  /** 获取文件下载签名 URL（需 viewer 权限，节点须 ready）。 */
  @Get("files/:id/url")
  downloadUrl(@CurrentUser() u: JwtMainPayload, @Param("id") id: string) {
    return this.drive.getDownloadUrl(this.ctx(u), id);
  }

  /**
   * 改名或移动节点。
   * - dto.name 有值 → 改名
   * - dto.parentId 有值（或 null）→ 移动
   */
  @Patch("nodes/:id")
  patch(
    @CurrentUser() u: JwtMainPayload,
    @Param("id") id: string,
    @Body() dto: RenameOrMoveDto,
  ) {
    if (dto.name !== undefined) {
      return this.drive.rename(this.ctx(u), id, dto.name);
    }
    return this.drive.move(this.ctx(u), id, dto.parentId ?? null);
  }

  /** 删除节点（递归删子树 + 清 grant + best-effort 删 Minio）。 */
  @Delete("nodes/:id")
  remove(@CurrentUser() u: JwtMainPayload, @Param("id") id: string) {
    return this.drive.deleteNode(this.ctx(u), id);
  }

  /** 列出节点的授权记录（需 viewer 权限）。 */
  @Get("nodes/:id/grants")
  listGrants(@CurrentUser() u: JwtMainPayload, @Param("id") id: string) {
    return this.drive.listGrants(this.ctx(u), id);
  }

  /** 全量覆盖节点授权列表（需 owner 权限）。 */
  @Put("nodes/:id/grants")
  setGrants(
    @CurrentUser() u: JwtMainPayload,
    @Param("id") id: string,
    @Body() dto: SetGrantsDto,
  ) {
    return this.drive.setGrants(this.ctx(u), id, dto);
  }
}
