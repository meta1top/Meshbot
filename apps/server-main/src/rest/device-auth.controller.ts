import { AppError } from "@meshbot/common";
import {
  DeviceAuthApproveDto,
  DeviceAuthExchangeDto,
  DeviceAuthStartDto,
  DeviceAuthService,
  DeviceService,
  MainErrorCode,
  UserService,
} from "@meshbot/main";
import type {
  DeviceAuthExchangeResult,
  DeviceAuthStartResult,
} from "@meshbot/types";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";
import { Public } from "../auth/public.decorator";
import { type AppConfig, APP_CONFIG } from "../config/app-config.schema";

/**
 * 设备授权（device authorization grant）端点：本地 Agent 走
 * start → 用户浏览器走 approve → 本地 Agent 轮询 exchange 拿到 device token。
 * Controller 只编排调用顺序，状态机 / 一次性 userCode / PKCE 校验全在 DeviceAuthService。
 */
@Controller("device-auth")
export class DeviceAuthController {
  constructor(
    private readonly deviceAuth: DeviceAuthService,
    private readonly devices: DeviceService,
    private readonly users: UserService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 本地 Agent 发起授权请求（公开端点，无身份）。 */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("start")
  @HttpCode(200)
  async start(@Body() dto: DeviceAuthStartDto): Promise<DeviceAuthStartResult> {
    const req = await this.deviceAuth.start({
      deviceName: dto.deviceName,
      platform: dto.platform ?? "",
      codeChallenge: dto.codeChallenge,
      redirectUri: dto.redirectUri ?? null,
    });
    return {
      requestId: req.id,
      verifyUrl: `${this.config.webMainBase}/authorize?request=${req.id}`,
    };
  }

  /** 授权确认页读取请求信息（已登录用户）。 */
  @Get("requests/:id")
  getRequest(@Param("id") id: string) {
    return this.deviceAuth.getForAuthorize(id);
  }

  /** 用户批准授权，生成一次性 userCode 回传给浏览器（供在本地 Agent 端输入）。 */
  @Post("approve")
  @HttpCode(200)
  approve(@CurrentUser() u: JwtMainPayload, @Body() dto: DeviceAuthApproveDto) {
    return this.deviceAuth.approve(dto.requestId, u.userId);
  }

  /** 本地 Agent 兑换 userCode + PKCE verifier，成功后签发 device token（公开端点）。 */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("exchange")
  @HttpCode(200)
  async exchange(
    @Body() dto: DeviceAuthExchangeDto,
  ): Promise<DeviceAuthExchangeResult> {
    const { userId, deviceName, platform } =
      await this.deviceAuth.exchange(dto);
    const user = await this.users.findById(userId);
    if (!user) throw new AppError(MainErrorCode.DEVICE_AUTH_REQUEST_INVALID);
    const { token } = await this.devices.issueDevice({
      userId,
      orgId: user.activeOrgId,
      name: deviceName,
      platform,
      machineId: dto.machineId ?? null,
    });
    return {
      deviceToken: token,
      user: { id: user.id, email: user.email, displayName: user.displayName },
      orgId: user.activeOrgId,
    };
  }
}
