import { InvitationService } from "./invitation.service";

/**
 * 单测聚焦 createInvitation 的过期刷新分支（过期 pending 死锁修复），
 * 用最小手写桩替代 Repository。完整邀请链路由 E2E 覆盖。
 */
describe("InvitationService.createInvitation", () => {
  const config = { expiresDays: 7 };

  it("已有未过期 pending → 原样复用（token 不变）", async () => {
    const existing = {
      id: "i1",
      token: "old-token",
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(existing),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
    };
    const svc = new InvitationService(repo as never, config);
    const out = await svc.createInvitation("o1", "u1", "b@x.io");
    expect(out.token).toBe("old-token");
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("已有 pending 但已过期 → 刷新 token 与有效期并持久化", async () => {
    const existing = {
      id: "i1",
      token: "old-token",
      status: "pending",
      expiresAt: new Date(Date.now() - 1000),
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(existing),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new InvitationService(repo as never, config);
    const out = await svc.createInvitation("o1", "u2", "b@x.io");
    expect(out.token).not.toBe("old-token");
    expect(out.token).toMatch(/^[0-9a-f]{48}$/);
    expect(out.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(repo.update).toHaveBeenCalledWith(
      { id: "i1" },
      expect.objectContaining({ token: out.token, invitedBy: "u2" }),
    );
  });
});
