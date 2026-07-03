import { AppError } from "@meshbot/common";
import {
  type AppUser,
  EmailVerificationService,
  LoginDto,
  MainErrorCode,
  MembershipService,
  RegisterUserDto,
  ResendCodeDto,
  SwitchOrgDto,
  UserService,
  VerifyEmailDto,
} from "@meshbot/main";
import { Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Throttle } from "@nestjs/throttler";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";
import { Public } from "../auth/public.decorator";
import { type AppConfig, APP_CONFIG } from "../config/app-config.schema";
import { EMAIL_SENDER, type EmailSender } from "../email/email-sender";

interface AuthTokenResponse {
  token: string;
  expiresIn: string;
  user: { id: string; email: string; displayName: string };
}

/**
 * 认证相关 endpoint。register / login / verify-email / resend-code 均公开访问。
 * Controller 只负责接收 DTO + 编排 + 签 token + 返回，业务逻辑下沉到
 * UserService / EmailVerificationService / EmailSender。
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly users: UserService,
    private readonly memberships: MembershipService,
    private readonly emailVerification: EmailVerificationService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
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

  /** 注册：建用户（未验证）+ 发验证码邮件，不签 token；需 verify-email 完成登录。 */
  @Public()
  // 限流：同源 IP 1 分钟内最多 5 次注册（防爬虫批量注册账号）
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("register")
  @HttpCode(201)
  async register(@Body() dto: RegisterUserDto): Promise<{ needVerify: true }> {
    const user = await this.users.registerUser(dto);
    const code = await this.emailVerification.issueCode(user.email);
    await this.email.sendVerificationCode(user.email, code);
    return { needVerify: true };
  }

  /** 校验注册邮箱验证码：通过即标记邮箱已验证并签 token（验证即登录）。 */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("verify-email")
  @HttpCode(200)
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<AuthTokenResponse> {
    await this.emailVerification.verifyCode(dto.email, dto.code);
    const user = await this.users.findByEmail(dto.email);
    if (!user) throw new AppError(MainErrorCode.AUTH_INVALID_CREDENTIALS);
    await this.users.markEmailVerified(user.id);
    return this.signResponse(user);
  }

  /**
   * 重发验证码。邮箱不存在静默返回 ok（防枚举）；冷却期内重复请求同样静默
   * ok 且不重复发信 —— 否则未知邮箱恒 ok、已注册邮箱二连发报 COOLDOWN，
   * 双请求即可探测账号是否存在（枚举侧信道）。前端自带 60s 倒计时按钮，
   * 不依赖冷却错误码。其他异常（发信失败等）照常上抛。
   */
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post("resend-code")
  @HttpCode(200)
  async resendCode(@Body() dto: ResendCodeDto): Promise<{ ok: true }> {
    const user = await this.users.findByEmail(dto.email);
    if (user) {
      try {
        const code = await this.emailVerification.issueCode(dto.email);
        await this.email.sendVerificationCode(dto.email, code);
      } catch (err) {
        const isCooldown =
          err instanceof AppError &&
          err.errorCode === MainErrorCode.AUTH_VERIFICATION_COOLDOWN;
        if (!isCooldown) throw err;
      }
    }
    return { ok: true };
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

  /** 切换当前活跃组织：校验成员 → 更新 activeOrgId → 重签含新 orgId 的 token。 */
  @Post("switch-org")
  @HttpCode(200)
  async switchOrg(
    @CurrentUser() jwt: JwtMainPayload,
    @Body() dto: SwitchOrgDto,
  ): Promise<AuthTokenResponse> {
    await this.memberships.assertMember(dto.orgId, jwt.userId);
    await this.users.setActiveOrg(jwt.userId, dto.orgId);
    const user = await this.users.findById(jwt.userId);
    if (!user) throw new AppError(MainErrorCode.ORG_NOT_FOUND);
    return this.signResponse(user);
  }

  private signResponse(user: AppUser): AuthTokenResponse {
    const token = this.jwt.sign({
      userId: user.id,
      email: user.email,
      orgId: user.activeOrgId ?? null,
    });
    return {
      token,
      expiresIn: this.config.jwt.expires,
      user: { id: user.id, email: user.email, displayName: user.displayName },
    };
  }
}
