import type { EmailVerification } from "../entities/email-verification.entity";
import { EmailVerificationService } from "./email-verification.service";

function makeRepo(rows: EmailVerification[]) {
  return {
    create: jest.fn(
      (v: Partial<EmailVerification>) =>
        ({ attempts: 0, ...v }) as EmailVerification,
    ),
    save: jest.fn(async (v: EmailVerification) => {
      v.id ??= `e${rows.length + 1}`;
      rows.push(v);
      return v;
    }),
    findOne: jest.fn(async ({ where, order }: never) => {
      const list = rows.filter(
        (r) => r.email === (where as { email: string }).email,
      );
      return (
        list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
        null
      );
    }),
    update: jest.fn(
      async (cond: { id: string }, patch: Partial<EmailVerification>) => {
        for (const r of rows) if (r.id === cond.id) Object.assign(r, patch);
      },
    ),
    delete: jest.fn(async (cond: { email: string }) => {
      for (let i = rows.length - 1; i >= 0; i--)
        if (rows[i].email === cond.email) rows.splice(i, 1);
    }),
  };
}

describe("EmailVerificationService", () => {
  it("issueCode 生成 6 位数字码并落库", async () => {
    const rows: EmailVerification[] = [];
    const svc = new EmailVerificationService(makeRepo(rows) as never);
    const code = await svc.issueCode("a@x.io");
    expect(code).toMatch(/^\d{6}$/);
    expect(rows[0].email).toBe("a@x.io");
  });

  it("60 秒内重发抛冷却错误", async () => {
    const rows: EmailVerification[] = [];
    const svc = new EmailVerificationService(makeRepo(rows) as never);
    await svc.issueCode("a@x.io");
    await expect(svc.issueCode("a@x.io")).rejects.toMatchObject({
      name: "AppError",
    });
  });

  it("verifyCode 正确码通过并清理记录", async () => {
    const rows: EmailVerification[] = [];
    const svc = new EmailVerificationService(makeRepo(rows) as never);
    const code = await svc.issueCode("a@x.io");
    await expect(svc.verifyCode("a@x.io", code)).resolves.toBeUndefined();
    expect(rows).toHaveLength(0);
  });

  it("错误码累计 5 次后即使输对也失效", async () => {
    const rows: EmailVerification[] = [];
    const svc = new EmailVerificationService(makeRepo(rows) as never);
    const code = await svc.issueCode("a@x.io");
    for (let i = 0; i < 5; i++)
      await expect(svc.verifyCode("a@x.io", "000000")).rejects.toBeTruthy();
    await expect(svc.verifyCode("a@x.io", code)).rejects.toBeTruthy();
  });

  it("过期码验证失败", async () => {
    const rows: EmailVerification[] = [];
    const svc = new EmailVerificationService(makeRepo(rows) as never);
    const code = await svc.issueCode("a@x.io");
    rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(svc.verifyCode("a@x.io", code)).rejects.toBeTruthy();
  });
});
