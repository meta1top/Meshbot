import {
  OrgModelConfigCreateDto,
  OrgModelConfigService,
  OrgModelConfigUpdateDto,
  OrgService,
} from "@meshbot/main";
import type { OrgModelConfigView } from "@meshbot/types";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";

/**
 * 组织级模型配置管理端点（owner 限定）。Controller 只做 owner 断言 + 委派，
 * 业务（apiKey 加密存储 / 打码视图）在 OrgModelConfigService。
 */
@Controller("orgs/:id/model-configs")
export class OrgModelConfigController {
  constructor(
    private readonly orgs: OrgService,
    private readonly configs: OrgModelConfigService,
  ) {}

  /** 配置列表（apiKey 打码）。 */
  @Get()
  async list(
    @CurrentUser() u: JwtMainPayload,
    @Param("id") orgId: string,
  ): Promise<OrgModelConfigView[]> {
    await this.orgs.assertOwner(orgId, u.userId);
    return this.configs.listForAdmin(orgId);
  }

  /** 新建配置。 */
  @Post()
  async create(
    @CurrentUser() u: JwtMainPayload,
    @Param("id") orgId: string,
    @Body() dto: OrgModelConfigCreateDto,
  ): Promise<OrgModelConfigView> {
    await this.orgs.assertOwner(orgId, u.userId);
    return this.configs.create(orgId, dto);
  }

  /** 更新配置；apiKey 缺省表示不换。 */
  @Patch(":configId")
  async update(
    @CurrentUser() u: JwtMainPayload,
    @Param("id") orgId: string,
    @Param("configId") configId: string,
    @Body() dto: OrgModelConfigUpdateDto,
  ): Promise<OrgModelConfigView> {
    await this.orgs.assertOwner(orgId, u.userId);
    return this.configs.update(orgId, configId, dto);
  }

  /** 删除配置。 */
  @Delete(":configId")
  async remove(
    @CurrentUser() u: JwtMainPayload,
    @Param("id") orgId: string,
    @Param("configId") configId: string,
  ): Promise<{ ok: true }> {
    await this.orgs.assertOwner(orgId, u.userId);
    await this.configs.remove(orgId, configId);
    return { ok: true };
  }
}
