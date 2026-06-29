import { CloudShareLinkService, CreateShareLinkDto } from "@meshbot/main";
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
} from "@nestjs/common";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";
import { type AppConfig, APP_CONFIG } from "../config/app-config.schema";

/**
 * 网盘公开分享链接 REST 端点。
 * Controller 只做请求接收与响应委派，owner 校验及业务逻辑在 CloudShareLinkService。
 */
@Controller("drive")
export class DriveShareLinkController {
  constructor(
    private readonly service: CloudShareLinkService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 将 token 拼接为前端分享页 URL。 */
  private shareUrl(token: string): string {
    return `${this.config.webMainBase}/share/${token}`;
  }

  /** owner 为文件创建公开分享链接。返回 {token, url}。 */
  @Post("nodes/:id/share-links")
  async create(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") id: string,
    @Body() dto: CreateShareLinkDto,
  ): Promise<{ token: string; url: string }> {
    const link = await this.service.create({ userId: user.userId }, id, dto);
    return { token: link.token, url: this.shareUrl(link.token) };
  }

  /** 列出某文件的全部有效公开链接（仅 owner）。 */
  @Get("nodes/:id/share-links")
  async list(@CurrentUser() user: JwtMainPayload, @Param("id") id: string) {
    const links = await this.service.listForNode({ userId: user.userId }, id);
    return links.map((l) => ({
      id: l.id,
      token: l.token,
      url: this.shareUrl(l.token),
      expiresAt: l.expiresAt,
      requiresPassword: !!l.passwordHash,
      createdAt: l.createdAt,
    }));
  }

  /** 撤销公开分享链接（仅 owner）。 */
  @Delete("share-links/:linkId")
  async revoke(
    @CurrentUser() user: JwtMainPayload,
    @Param("linkId") linkId: string,
  ): Promise<{ ok: true }> {
    await this.service.revoke({ userId: user.userId }, linkId);
    return { ok: true };
  }
}
