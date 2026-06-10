import {
  type AppUser,
  LoginDto,
  MembershipService,
  RegisterUserDto,
  UserService,
} from "@meshbot/main";
import { Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Throttle } from "@nestjs/throttler";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";
import { Public } from "../auth/public.decorator";
import { type AppConfig, APP_CONFIG } from "../config/app-config.schema";

interface AuthTokenResponse {
  token: string;
  expiresIn: string;
  user: { id: string; email: string; displayName: string };
}

/**
 * 认证相关 endpoint。register / login 均公开访问。
 * Controller 只负责接收 DTO + 签 token + 返回，业务逻辑下沉到 UserService。
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly users: UserService,
    private readonly memberships: MembershipService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 当前用户 profile：身份 + 活跃组织 + 全部组织。供 server-agent 镜像。 */
  @Get("profile")
  async profile(@CurrentUser() jwt: JwtMainPayload) {
    const user = await this.users.findById(jwt.userId);
    const orgs = await this.memberships.listOrgsForUser(jwt.userId);
    const activeOrg =
      user?.activeOrgId != null
        ? (orgs.find((o) => o.id === user.activeOrgId) ?? null)
        : null;
    return {
      user: user
        ? { id: user.id, email: user.email, displayName: user.displayName }
        : null,
      activeOrg,
      memberships: orgs,
    };
  }

  @Public()
  // 限流：同源 IP 1 分钟内最多 5 次注册（防爬虫批量注册账号）
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("register")
  @HttpCode(201)
  async register(@Body() dto: RegisterUserDto): Promise<AuthTokenResponse> {
    const user = await this.users.registerUser(dto);
    return this.signResponse(user);
  }

  @Public()
  // 限流：同源 IP 1 分钟内最多 10 次登录（防密码爆破）
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("login")
  @HttpCode(200)
  async login(@Body() dto: LoginDto): Promise<AuthTokenResponse> {
    const user = await this.users.loginUser(dto);
    return this.signResponse(user);
  }

  private signResponse(user: AppUser): AuthTokenResponse {
    const token = this.jwt.sign({ userId: user.id, email: user.email });
    return {
      token,
      expiresIn: this.config.jwt.expires,
      user: { id: user.id, email: user.email, displayName: user.displayName },
    };
  }
}
