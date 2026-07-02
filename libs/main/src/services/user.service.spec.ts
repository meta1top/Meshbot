import * as bcrypt from "bcrypt";

import { AppUser } from "../entities/app-user.entity";
import { MainErrorCode } from "../errors/main.error-codes";
import { UserService } from "./user.service";

/**
 * 单测聚焦 loginUser 的邮箱验证拦截与 markEmailVerified 的落库行为，
 * 用最小手写桩替代 Repository。
 */
describe("UserService", () => {
  async function makeUser(overrides: Partial<AppUser> = {}): Promise<AppUser> {
    return {
      id: "u1",
      email: "a@x.io",
      passwordHash: await bcrypt.hash("password1", 4),
      displayName: "A",
      activeOrgId: null,
      emailVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as AppUser;
  }

  describe("loginUser", () => {
    it("emailVerifiedAt 为空 → 抛 AUTH_EMAIL_NOT_VERIFIED", async () => {
      const user = await makeUser({ emailVerifiedAt: null });
      const repo = { findOne: jest.fn().mockResolvedValue(user) };
      const svc = new UserService(repo as never);
      await expect(
        svc.loginUser({ email: user.email, password: "password1" }),
      ).rejects.toMatchObject({
        name: "AppError",
        errorCode: { code: MainErrorCode.AUTH_EMAIL_NOT_VERIFIED.code },
      });
    });

    it("emailVerifiedAt 已设置 → 登录成功返回用户", async () => {
      const user = await makeUser({ emailVerifiedAt: new Date() });
      const repo = { findOne: jest.fn().mockResolvedValue(user) };
      const svc = new UserService(repo as never);
      const out = await svc.loginUser({
        email: user.email,
        password: "password1",
      });
      expect(out.id).toBe(user.id);
    });

    it("密码错误 → 优先抛 AUTH_INVALID_CREDENTIALS（先于邮箱验证检查）", async () => {
      const user = await makeUser({ emailVerifiedAt: null });
      const repo = { findOne: jest.fn().mockResolvedValue(user) };
      const svc = new UserService(repo as never);
      await expect(
        svc.loginUser({ email: user.email, password: "wrong" }),
      ).rejects.toMatchObject({
        name: "AppError",
        errorCode: { code: MainErrorCode.AUTH_INVALID_CREDENTIALS.code },
      });
    });
  });

  describe("markEmailVerified", () => {
    it("调用 update({id}, {emailVerifiedAt: Date})", async () => {
      const repo = { update: jest.fn().mockResolvedValue(undefined) };
      const svc = new UserService(repo as never);
      await svc.markEmailVerified("u1");
      expect(repo.update).toHaveBeenCalledWith(
        { id: "u1" },
        { emailVerifiedAt: expect.any(Date) },
      );
    });
  });
});
