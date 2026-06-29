import { AppError } from "@meshbot/common";
import {
  CloudShareLinkService,
  MainErrorCode,
  ShareDownloadDto,
} from "@meshbot/main";
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { Public } from "../auth/public.decorator";

/**
 * 网盘公开分享匿名端点。
 * 两个方法均标注 @Public()，跳过 JwtAuthGuard，无需 JWT token。
 * Controller 只做请求接收与委派，业务逻辑在 CloudShareLinkService。
 */
@Controller("share")
export class PublicShareController {
  constructor(private readonly service: CloudShareLinkService) {}

  /**
   * 取公开文件元信息。不暴露内部 id（nodeId/orgId/createdByUserId）。
   * 返回 {name, sizeBytes, mime, requiresPassword}。
   */
  @Public()
  @Get(":token")
  async info(@Param("token") token: string): Promise<{
    name: string;
    sizeBytes: number;
    mime: string;
    requiresPassword: boolean;
  }> {
    const { link, node } = await this.service.resolveOrThrow(token);
    return {
      name: node.name,
      sizeBytes: Number(node.sizeBytes),
      mime: node.mime ?? "",
      requiresPassword: !!link.passwordHash,
    };
  }

  /**
   * 校验密码后返回 presigned 下载 URL（绕 ACL，token 本身即凭证）。
   * 返回 {url, name, mime}。
   */
  @Public()
  @Post(":token/download")
  async download(
    @Param("token") token: string,
    @Body() dto: ShareDownloadDto,
  ): Promise<{ url: string; name: string; mime: string }> {
    const { link, node } = await this.service.resolveOrThrow(token);
    const ok = await this.service.verifyPassword(link, dto.password);
    if (!ok) {
      throw new AppError(MainErrorCode.DRIVE_SHARE_PASSWORD_INVALID);
    }
    return this.service.signDownload(node);
  }
}
