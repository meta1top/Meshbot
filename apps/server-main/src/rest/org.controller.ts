import {
  AcceptInvitationDto,
  CreateInvitationDto,
  CreateOrgDto,
  InvitationService,
  MembershipService,
  OrgService,
  UserService,
} from "@meshbot/main";
import type {
  InvitationSummary,
  MemberSummary,
  OrgSummary,
} from "@meshbot/types-main";
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  Param,
  Post,
} from "@nestjs/common";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";
import { EMAIL_SENDER, type EmailSender } from "../email/email-sender";

/**
 * 组织相关端点。均需登录（全局 JwtAuthGuard）。Controller 只接收 + 委派，
 * 业务在 Org/Membership/Invitation Service。
 *
 * 路由顺序注意：`invitations/accept`（静态段）必须声明在 `:id/...`（参数段）
 * 之前 —— NestJS 按声明顺序匹配，否则 POST /orgs/invitations/accept 会被
 * `:id/invitations` 以 id="invitations" 截获。
 */
@Controller("orgs")
export class OrgController {
  private readonly logger = new Logger(OrgController.name);

  constructor(
    private readonly orgs: OrgService,
    private readonly memberships: MembershipService,
    private readonly invitations: InvitationService,
    private readonly users: UserService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  /** 我的组织列表。 */
  @Get()
  async listMine(@CurrentUser() user: JwtMainPayload): Promise<OrgSummary[]> {
    return this.memberships.listOrgsForUser(user.userId);
  }

  /** 创建组织（成为 owner）。 */
  @Post()
  async create(
    @CurrentUser() user: JwtMainPayload,
    @Body() dto: CreateOrgDto,
  ): Promise<OrgSummary> {
    return this.orgs.persistNewOrg(user.userId, dto.name);
  }

  /** 接受邀请（任何登录用户，粘贴邀请码）。必须先于 `:id/...` 参数路由声明。 */
  @Post("invitations/accept")
  async accept(
    @CurrentUser() user: JwtMainPayload,
    @Body() dto: AcceptInvitationDto,
  ): Promise<{ orgId: string; orgName: string }> {
    return this.invitations.acceptInvitation(dto.token, user.userId);
  }

  /** 组织成员列表（成员可见）。 */
  @Get(":id/members")
  async members(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") orgId: string,
  ): Promise<MemberSummary[]> {
    await this.assertMember(orgId, user.userId);
    return this.memberships.listMembers(orgId);
  }

  /** 邀请成员（owner 限定），建邀请并发邮件。 */
  @Post(":id/invitations")
  async invite(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") orgId: string,
    @Body() dto: CreateInvitationDto,
  ): Promise<InvitationSummary> {
    await this.orgs.assertOwner(orgId, user.userId);
    const org = await this.orgs.getOrgOrThrow(orgId);
    const invite = await this.invitations.createInvitation(
      orgId,
      user.userId,
      dto.email,
    );
    await this.sendInvitationMail(
      dto.email,
      org.name,
      user.userId,
      invite.token,
      invite.expiresAt,
    );
    return {
      id: invite.id,
      email: invite.email,
      status: invite.status as InvitationSummary["status"],
      token: invite.token,
      expiresAt: invite.expiresAt.toISOString(),
      createdAt: invite.createdAt.toISOString(),
    };
  }

  /** 组织 pending 邀请列表（owner 限定）。 */
  @Get(":id/invitations")
  async listInvitations(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") orgId: string,
  ): Promise<InvitationSummary[]> {
    await this.orgs.assertOwner(orgId, user.userId);
    return this.invitations.listPending(orgId);
  }

  /** 重发邀请邮件（owner 限定）。 */
  @Post(":id/invitations/:invitationId/resend")
  async resend(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") orgId: string,
    @Param("invitationId") invitationId: string,
  ): Promise<{ ok: true }> {
    await this.orgs.assertOwner(orgId, user.userId);
    const org = await this.orgs.getOrgOrThrow(orgId);
    const invite = await this.invitations.findById(invitationId);
    if (invite && invite.orgId === orgId && invite.status === "pending") {
      await this.sendInvitationMail(
        invite.email,
        org.name,
        user.userId,
        invite.token,
        invite.expiresAt,
      );
    }
    return { ok: true };
  }

  /** 撤销邀请（owner 限定）。 */
  @Delete(":id/invitations/:invitationId")
  async revoke(
    @CurrentUser() user: JwtMainPayload,
    @Param("id") orgId: string,
    @Param("invitationId") invitationId: string,
  ): Promise<{ ok: true }> {
    await this.orgs.assertOwner(orgId, user.userId);
    const invite = await this.invitations.findById(invitationId);
    if (invite && invite.orgId === orgId) {
      await this.invitations.revoke(invitationId);
    }
    return { ok: true };
  }

  /** 非成员访问成员资源 → ORG_FORBIDDEN（owner 必为成员，借 assertOwner 抛错）。 */
  private async assertMember(orgId: string, userId: string): Promise<void> {
    const ok = await this.memberships.isMember(orgId, userId);
    if (!ok) {
      await this.orgs.assertOwner(orgId, userId);
    }
  }

  /** 发送/重发邀请邮件。发送失败不抛错（邀请已建好，owner 可重发）。 */
  private async sendInvitationMail(
    to: string,
    orgName: string,
    inviterId: string,
    code: string,
    expiresAt: Date,
  ): Promise<void> {
    try {
      const inviter = await this.users.findById(inviterId);
      await this.email.sendInvitation(to, {
        orgName,
        inviterName: inviter?.displayName ?? "管理员",
        code,
        expiresAt,
      });
    } catch (err) {
      // 邮件失败不影响邀请本身（已落库），owner 可在邀请列表里重发
      this.logger.error(
        `邀请邮件发送失败（to=${to} org=${orgName}）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
