import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";

import { SwitchOrgDto } from "../dto/org.dto";
import { CloudAuthService } from "../services/cloud-auth.service";
import { CloudOrgService } from "../services/cloud-org.service";

/**
 * 云端组织端点的本地薄代理（精简版）。
 * 仅保留 IM 与组织切换依赖的三个端点。
 * 组织管理操作（建组织/邀请/接受邀请）已转移到云端 web-main。
 */
@Controller("api/orgs")
export class CloudOrgController {
  constructor(
    private readonly cloudOrg: CloudOrgService,
    private readonly cloudAuth: CloudAuthService,
  ) {}

  @Get()
  list() {
    return this.cloudOrg.listMine();
  }

  /** 切换当前活跃组织（代理云端 + 同步本地镜像）。 */
  @Post("switch")
  @HttpCode(200)
  switchOrg(@Body() dto: SwitchOrgDto) {
    return this.cloudAuth.switchOrg(dto.orgId);
  }

  @Get(":id/members")
  members(@Param("id") orgId: string) {
    return this.cloudOrg.listMembers(orgId);
  }
}
