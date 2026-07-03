import { LogEmailSender } from "./email-sender";

describe("LogEmailSender", () => {
  it("sendInvitation 不真实发送，记录日志且不抛错", async () => {
    const sender = new LogEmailSender();
    await expect(
      sender.sendInvitation("bob@test.io", {
        orgName: "Acme",
        inviterName: "Alice",
        code: "abc123",
        expiresAt: new Date("2026-06-18T00:00:00Z"),
      }),
    ).resolves.toBeUndefined();
  });

  it("sendVerificationCode 不真实发送，记录日志且不抛错", async () => {
    const sender = new LogEmailSender();
    await expect(
      sender.sendVerificationCode("bob@test.io", "123456"),
    ).resolves.toBeUndefined();
  });
});
