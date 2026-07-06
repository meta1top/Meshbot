import { AppError, CommonErrorCode } from "@meshbot/common";
import {
  DeviceService,
  DeviceSwitchOrgDto,
  MembershipService,
  UserService,
} from "@meshbot/main";
import type { DeviceView } from "@meshbot/types";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";

/**
 * 设备（device token）管理端点。列表 / 吊销走用户 JWT；switch-org 走设备 token
 * （Task 8 落地设备 token 识别 —— 在此之前用普通用户 JWT 调用因缺 deviceId 恒 403）。
 */
@Controller("devices")
export class DeviceController {
  constructor(
    private readonly devices: DeviceService,
    private readonly memberships: MembershipService,
    private readonly users: UserService,
  ) {}

  /** 我的设备列表（含已吊销，前端区分展示）。 */
  @Get()
  async list(@CurrentUser() u: JwtMainPayload): Promise<DeviceView[]> {
    const rows = await this.devices.listByUser(u.userId);
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
      revokedAt: d.revokedAt ? d.revokedAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
      isCurrent: d.id === u.deviceId,
    }));
  }

  /** 吊销本人设备。 */
  @Delete(":id")
  async revoke(
    @CurrentUser() u: JwtMainPayload,
    @Param("id") id: string,
  ): Promise<{ ok: true }> {
    await this.devices.revoke(u.userId, id);
    return { ok: true };
  }

  /**
   * 设备切换当前激活组织。要求设备 token 身份（`u.deviceId` 由 Task 8 的设备
   * token 识别落地后填充）；无 deviceId（如误用普通用户 JWT 调用）一律 403，
   * 防止越权改写非本设备的组织归属。
   */
  @Post("switch-org")
  @HttpCode(200)
  async switchOrg(
    @CurrentUser() u: JwtMainPayload,
    @Body() dto: DeviceSwitchOrgDto,
  ): Promise<{ ok: true }> {
    if (!u.deviceId) throw new AppError(CommonErrorCode.FORBIDDEN);
    await this.memberships.assertMember(dto.orgId, u.userId);
    await this.devices.updateOrg(u.deviceId, dto.orgId);
    await this.users.setActiveOrg(u.userId, dto.orgId);
    return { ok: true };
  }
}
