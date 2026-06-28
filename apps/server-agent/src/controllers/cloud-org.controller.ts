import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";

import {
  AcceptInvitationDto,
  CreateOrgDto,
  InviteMemberDto,
  SwitchOrgDto,
} from "../dto/org.dto";
import { CloudAuthService } from "../services/cloud-auth.service";
import { CloudOrgService } from "../services/cloud-org.service";

/**
 * 云端组织端点的本地薄代理（方案 A）。全部受本地 JWT 保护。
 * 路由顺序：静态段 invitations/accept 先于 :id 参数路由声明。
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

  @Post()
  create(@Body() dto: CreateOrgDto) {
    return this.cloudOrg.createOrg(dto.name);
  }

  /** 切换当前活跃组织（代理云端 + 同步本地镜像）。 */
  @Post("switch")
  @HttpCode(200)
  switchOrg(@Body() dto: SwitchOrgDto) {
    return this.cloudAuth.switchOrg(dto.orgId);
  }

  @Post("invitations/accept")
  accept(@Body() dto: AcceptInvitationDto) {
    return this.cloudOrg.acceptInvitation(dto.token);
  }

  @Get(":id/members")
  members(@Param("id") orgId: string) {
    return this.cloudOrg.listMembers(orgId);
  }

  @Post(":id/invitations")
  invite(@Param("id") orgId: string, @Body() dto: InviteMemberDto) {
    return this.cloudOrg.invite(orgId, dto.email);
  }

  @Get(":id/invitations")
  invitations(@Param("id") orgId: string) {
    return this.cloudOrg.listInvitations(orgId);
  }

  @Post(":id/invitations/:invitationId/resend")
  resend(
    @Param("id") orgId: string,
    @Param("invitationId") invitationId: string,
  ) {
    return this.cloudOrg.resendInvitation(orgId, invitationId);
  }

  @Delete(":id/invitations/:invitationId")
  revoke(
    @Param("id") orgId: string,
    @Param("invitationId") invitationId: string,
  ) {
    return this.cloudOrg.revokeInvitation(orgId, invitationId);
  }
}
