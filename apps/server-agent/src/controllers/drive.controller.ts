import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";

import { DriveGatewayService } from "../services/drive-gateway.service";

/**
 * 网盘端点的本地薄代理（方案 A）。全部受本地 JWT 保护。
 * 将 server-agent 的 /api/drive/* 请求转发至 server-main 同名接口。
 * 路由顺序：静态段优先于参数路由声明。
 */
@Controller("api/drive")
export class DriveController {
  constructor(private readonly drive: DriveGatewayService) {}

  /** 列出目录节点；parentId 可选，缺省为根目录。 */
  @Get("nodes")
  listNodes(@Query("parentId") parentId?: string) {
    return this.drive.listNodes(parentId ?? null);
  }

  /** 列出他人共享给我的节点。 */
  @Get("shared")
  listShared() {
    return this.drive.listShared();
  }

  /** 获取存储配额信息。 */
  @Get("quota")
  getQuota() {
    return this.drive.getQuota();
  }

  /** 创建文件夹。 */
  @Post("folders")
  createFolder(@Body() body: unknown) {
    return this.drive.createFolder(body);
  }

  /** 申请上传，返回含 presigned putUrl 的响应。 */
  @Post("uploads")
  requestUpload(@Body() body: unknown) {
    return this.drive.requestUpload(body);
  }

  /** 确认上传完成。 */
  @Post("uploads/:nodeId/complete")
  completeUpload(@Param("nodeId") nodeId: string, @Body() body: unknown) {
    return this.drive.completeUpload(nodeId, body);
  }

  /** 获取文件下载 URL（presigned）。 */
  @Get("files/:id/url")
  getFileUrl(@Param("id") id: string) {
    return this.drive.getFileUrl(id);
  }

  /** 更新节点元数据（重命名/移动）。 */
  @Patch("nodes/:id")
  updateNode(@Param("id") id: string, @Body() body: unknown) {
    return this.drive.updateNode(id, body);
  }

  /** 删除节点（含子树）。 */
  @Delete("nodes/:id")
  deleteNode(@Param("id") id: string) {
    return this.drive.deleteNode(id);
  }

  /** 获取节点权限列表。 */
  @Get("nodes/:id/grants")
  getGrants(@Param("id") id: string) {
    return this.drive.getGrants(id);
  }

  /** 设置节点权限（完整覆盖）。 */
  @Put("nodes/:id/grants")
  setGrants(@Param("id") id: string, @Body() body: unknown) {
    return this.drive.setGrants(id, body);
  }
}
