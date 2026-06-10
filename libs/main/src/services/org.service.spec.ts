import { AppError } from "@meshbot/common";
import { MainErrorCode } from "../errors/main.error-codes";
import type { MembershipService } from "./membership.service";
import { OrgService } from "./org.service";

/**
 * 单测聚焦 OrgService 的纯逻辑分支（权限校验），用最小手写桩替代依赖。
 * 完整建组织 + 事务持久化由 Task 9 E2E 覆盖。
 */
describe("OrgService.assertOwner", () => {
  function build(
    roleOf: (orgId: string, userId: string) => Promise<string | null>,
  ): OrgService {
    const membership = { roleOf } as unknown as MembershipService;
    return new OrgService({} as never, membership);
  }

  it("非 owner 抛 ORG_FORBIDDEN", async () => {
    const svc = build(async () => "member");
    await expect(svc.assertOwner("org1", "user1")).rejects.toMatchObject({
      errorCode: MainErrorCode.ORG_FORBIDDEN,
    });
  });

  it("owner 通过", async () => {
    const svc = build(async () => "owner");
    await expect(svc.assertOwner("org1", "user1")).resolves.toBeUndefined();
  });

  it("非成员抛 ORG_FORBIDDEN", async () => {
    const svc = build(async () => null);
    await expect(svc.assertOwner("org1", "user1")).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
