import Dm, { SingleSendMailRequest } from "@alicloud/dm20151123";
import * as OpenApi from "@alicloud/openapi-client";
import * as Util from "@alicloud/tea-util";
import { Logger } from "@nestjs/common";

import type { EmailConfig } from "../config/app-config.schema";

/** 一封组织邀请邮件的内容参数。 */
export interface InvitationMail {
  orgName: string;
  inviterName: string;
  /** 邀请码（invitation.token），收件人在桌面端粘贴加入。 */
  code: string;
  expiresAt: Date;
}

/** 邮件发送端口。Phase 1 只发组织邀请。 */
export interface EmailSender {
  sendInvitation(to: string, mail: InvitationMail): Promise<void>;
}

/** EmailSender 的 DI token。 */
export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

function buildInvitationText(mail: InvitationMail): {
  subject: string;
  text: string;
} {
  const expires = mail.expiresAt.toISOString().slice(0, 10);
  return {
    subject: `${mail.inviterName} 邀请你加入「${mail.orgName}」`,
    text:
      `${mail.inviterName} 邀请你加入企业「${mail.orgName}」。\n\n` +
      `请在 meshbot 桌面端登录后，进入「加入组织」并粘贴以下邀请码：\n\n` +
      `    ${mail.code}\n\n` +
      `邀请码有效期至 ${expires}。若非本人预期，请忽略本邮件。`,
  };
}

/** 阿里云邮件推送 DirectMail 实现（SingleSendMail）。凭证走 config.email。 */
export class DirectMailEmailSender implements EmailSender {
  private readonly client: Dm;
  private readonly accountName: string;
  private readonly fromAlias?: string;

  constructor(config: EmailConfig) {
    const openapi = new OpenApi.Config({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
    });
    openapi.endpoint = config.endpoint;
    this.client = new Dm(openapi);
    this.accountName = config.accountName;
    this.fromAlias = config.from;
  }

  /** 发送一封组织邀请邮件（addressType=1 用发信地址，不设回信地址）。 */
  async sendInvitation(to: string, mail: InvitationMail): Promise<void> {
    const { subject, text } = buildInvitationText(mail);
    const request = new SingleSendMailRequest({
      accountName: this.accountName,
      addressType: 1,
      replyToAddress: false,
      toAddress: to,
      subject,
      textBody: text,
      fromAlias: this.fromAlias,
    });
    await this.client.singleSendMailWithOptions(
      request,
      new Util.RuntimeOptions({}),
    );
  }
}

/** 未配置 config.email 时的兜底：把邀请码打到 server 日志（仅开发用）。 */
export class LogEmailSender implements EmailSender {
  private readonly logger = new Logger("LogEmailSender");

  /** 不真实发送，只把邀请信息打日志，方便本地开发联调。 */
  async sendInvitation(to: string, mail: InvitationMail): Promise<void> {
    this.logger.warn(
      `[DEV] 未配置 config.email，邀请邮件不真实发送 —— to=${to} ` +
        `org=${mail.orgName} code=${mail.code}`,
    );
  }
}
