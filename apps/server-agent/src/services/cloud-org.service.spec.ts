import { AccountContextService } from "@meshbot/lib-agent";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { CloudOrgService } from "./cloud-org.service";

/** 测试账号：org 路由在账号上下文内运行，方法调用均包 account.run(USER, ...)。 */
const USER = "u1";

describe("CloudOrgService", () => {
  function build(opts: {
    identity?: Partial<{ get: jest.Mock }>;
    cloud?: Partial<{ get: jest.Mock }>;
  }) {
    const identity = {
      get: jest.fn().mockResolvedValue({ deviceToken: "ct-1" }),
      ...opts.identity,
    };
    const cloud = {
      get: jest.fn(),
      ...opts.cloud,
    };
    const account = new AccountContextService();
    return {
      svc: new CloudOrgService(cloud as never, identity as never, account),
      identity,
      cloud,
      account,
    };
  }

  it("无云端 token → AUTH_UNAUTHORIZED", async () => {
    const { svc, account } = build({
      identity: { get: jest.fn().mockResolvedValue(null) },
    });
    await expect(account.run(USER, () => svc.listMine())).rejects.toMatchObject(
      {
        errorCode: AgentErrorCode.AUTH_UNAUTHORIZED,
      },
    );
  });

  it("listMembers 成功返回成员列表", async () => {
    const { svc, cloud, account } = build({
      cloud: {
        get: jest
          .fn()
          .mockResolvedValue([
            { id: "u1", email: "alice@example.com", role: "owner" },
          ]),
      },
    });
    const out = await account.run(USER, () => svc.listMembers("o1"));
    expect(out).toEqual([
      { id: "u1", email: "alice@example.com", role: "owner" },
    ]);
    expect(cloud.get).toHaveBeenCalledWith("/api/orgs/o1/members", "ct-1");
  });

  it("listMine 成功返回我的组织列表", async () => {
    const { svc, cloud, account } = build({
      cloud: {
        get: jest.fn().mockResolvedValue([
          { id: "o1", name: "Acme", role: "owner" },
          { id: "o2", name: "Beta", role: "member" },
        ]),
      },
    });
    const out = await account.run(USER, () => svc.listMine());
    expect(out).toEqual([
      { id: "o1", name: "Acme", role: "owner" },
      { id: "o2", name: "Beta", role: "member" },
    ]);
    expect(cloud.get).toHaveBeenCalledWith("/api/orgs", "ct-1");
  });
});
