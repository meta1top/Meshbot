import { Body, Controller, Get, Post } from "@nestjs/common";

import { LoginDto, RegisterDto } from "../dto/auth.dto";
import { Public } from "../guards/jwt-auth.guard";
import { CloudAuthService } from "../services/cloud-auth.service";

/** 认证端点：代理云端 register/login，本地只签发 / 校验本地 JWT。 */
@Controller("api/auth")
export class AuthController {
  constructor(private readonly cloudAuth: CloudAuthService) {}

  @Public()
  @Post("register")
  register(@Body() dto: RegisterDto) {
    return this.cloudAuth.register(dto);
  }

  @Public()
  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.cloudAuth.login(dto);
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
