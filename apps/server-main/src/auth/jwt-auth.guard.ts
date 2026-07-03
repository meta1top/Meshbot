import { AppError } from "@meshbot/common";
import {
  DEVICE_TOKEN_PREFIX,
  DeviceService,
  MainErrorCode,
  UserService,
} from "@meshbot/main";
import { type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";

import { IS_PUBLIC_KEY } from "./public.decorator";
import { JWT_MAIN_STRATEGY_NAME } from "./jwt.strategy";

/**
 * 全局认证守卫 —— 双凭据（Task 8）：
 *
 * 1. `Authorization: Bearer mbd_...`（Agent device token）→ `DeviceService.verifyToken`
 *    校验后注入 `req.user = { userId, email, orgId, deviceId }`（orgId 来自
 *    `device.orgId`，与用户 `activeOrgId` 解耦）。
 * 2. 其余走 Passport `jwt-main` Strategy（浏览器用户 JWT），行为不变。
 *
 * `@Public()` 标记的端点直接放行。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard(JWT_MAIN_STRATEGY_NAME) {
  constructor(
    private readonly reflector: Reflector,
    private readonly devices: DeviceService,
    private readonly users: UserService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
    }>();
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (bearer.startsWith(DEVICE_TOKEN_PREFIX)) {
      const device = await this.devices.verifyToken(bearer);
      const user = await this.users.findById(device.userId);
      if (!user) throw new AppError(MainErrorCode.DEVICE_TOKEN_INVALID);
      req.user = {
        userId: user.id,
        email: user.email,
        orgId: device.orgId,
        deviceId: device.id,
      };
      return true;
    }
    return super.canActivate(context) as Promise<boolean>;
  }
}
