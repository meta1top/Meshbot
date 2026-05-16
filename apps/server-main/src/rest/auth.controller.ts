import {
  type AppUser,
  LoginDto,
  RegisterUserDto,
  UserService,
} from "@meshbot/main";
import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../auth/public.decorator";

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
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

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
      expiresIn: this.config.get<string>("JWT_EXPIRES") ?? "7d",
      user: { id: user.id, email: user.email, displayName: user.displayName },
    };
  }
}
