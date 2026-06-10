import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";

import {
  AcceptInvitationDto,
  CreateOrgDto,
  InviteMemberDto,
} from "../dto/org.dto";
import { CloudOrgService } from "../services/cloud-org.service";

/**
 * 云端组织端点的本地薄代理（方案 A）。全部受本地 JWT 保护。
 * 路由顺序：静态段 invitations/accept 先于 :id 参数路由声明。
 */
@Controller("api/orgs")
export class CloudOrgController {
  constructor(private readonly cloudOrg: CloudOrgService) {}

  @Get()
  list() {
    return this.cloudOrg.listMine();
  }

  @Post()
  create(@Body() dto: CreateOrgDto) {
    return this.cloudOrg.createOrg(dto.name);
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
