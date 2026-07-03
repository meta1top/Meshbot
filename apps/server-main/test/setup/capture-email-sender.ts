import { Module } from "@nestjs/common";

import {
  EMAIL_SENDER,
  type EmailSender,
  type InvitationMail,
} from "../../src/email/email-sender";

/**
 * e2e 共享测试 EmailSender：捕获最后一次邀请邮件 / 验证码，供断言与
 * `registerAndVerify` 助手取码（见 `register-and-verify.ts`）。
 */
export class CaptureEmailSender implements EmailSender {
  last: { to: string; mail: InvitationMail } | null = null;
  lastVerification: { to: string; code: string } | null = null;

  async sendInvitation(to: string, mail: InvitationMail): Promise<void> {
    this.last = { to, mail };
  }

  async sendVerificationCode(to: string, code: string): Promise<void> {
    this.lastVerification = { to, code };
  }
}

/**
 * 把一个 CaptureEmailSender 实例绑定到 EMAIL_SENDER token 的测试模块工厂。
 * 每个 e2e 套件各自持有独立的 CaptureEmailSender 实例（互不干扰）。
 */
export function buildCaptureEmailModule(sender: CaptureEmailSender) {
  @Module({
    providers: [{ provide: EMAIL_SENDER, useValue: sender }],
    exports: [EMAIL_SENDER],
  })
  class TestEmailModule {}
  return TestEmailModule;
}
