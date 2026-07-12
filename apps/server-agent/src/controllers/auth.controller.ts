import { SkipResponseEnvelope } from "@meshbot/common";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
} from "@nestjs/common";

import { renderAuthorizeResultPage } from "./authorize-result.page";
import { AuthorizeCompleteDto, AuthorizePollDto } from "../dto/auth.dto";
import { Public } from "../guards/jwt-auth.guard";
import { CloudAuthService } from "../services/cloud-auth.service";
import { CloudMetaService } from "../services/cloud-meta.service";
import { DeviceAuthorizeService } from "../services/device-authorize.service";

/** 认证端点：浏览器授权登录编排 + 登出 / profile 读取。 */
@Controller("api/auth")
export class AuthController {
  constructor(
    private readonly cloudAuth: CloudAuthService,
    private readonly deviceAuthorize: DeviceAuthorizeService,
    private readonly cloudMeta: CloudMetaService,
  ) {}

  /** 发起浏览器授权登录：返回云端授权页 URL，前端负责打开浏览器。 */
  @Public()
  @Post("authorize/start")
  @HttpCode(200)
  startAuthorize() {
    return this.deviceAuthorize.start();
  }

  /** 浏览器授权回调（loopback 重定向）：兑换成功/失败均返回极简 HTML 提示页。 */
  @Public()
  @Get("callback")
  @SkipResponseEnvelope()
  @Header("Content-Type", "text/html; charset=utf-8")
  async callback(
    @Query("request") requestId: string,
    @Query("code") code: string,
  ): Promise<string> {
    try {
      await this.deviceAuthorize.complete(requestId, code);
      return renderAuthorizeResultPage("success");
    } catch {
      return renderAuthorizeResultPage("failure");
    }
  }

  /** 手动粘贴授权码完成登录（回调失败 / 无 loopback 场景兜底）。 */
  @Public()
  @Post("authorize/complete")
  @HttpCode(200)
  completeAuthorize(@Body() dto: AuthorizeCompleteDto) {
    return this.deviceAuthorize.completeByCode(dto.code);
  }

  /** 前端轮询取本地登录态（一次性）。 */
  @Public()
  @Post("authorize/poll")
  @HttpCode(200)
  pollAuthorize(@Body() dto: AuthorizePollDto) {
    return this.deviceAuthorize.poll(dto.requestId);
  }

  /** 云端 web-main 基础 URL（供前端拼注册页 / 组织后台跳转链接），代理并进程内缓存。 */
  @Public()
  @Get("cloud-web-url")
  async cloudWebUrl(): Promise<{ webMainBase: string }> {
    return { webMainBase: await this.cloudMeta.getWebMainBase() };
  }

  /** 登出：清云端身份镜像（本地 JWT 由前端自行丢弃）。 */
  @Post("logout")
  async logout() {
    await this.cloudAuth.logout();
    return { ok: true };
  }

  /** 当前用户 profile（读本地镜像，不打云端）。401 由 guard/service 处理。 */
  @Get("profile")
  profile() {
    return this.cloudAuth.getProfile();
  }
}
