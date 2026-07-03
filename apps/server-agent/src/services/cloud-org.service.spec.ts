import { AccountContextService } from "@meshbot/agent";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { CloudOrgService } from "./cloud-org.service";

/** 测试账号：org 路由在账号上下文内运行，方法调用均包 account.run(USER, ...)。 */
const USER = "u1";

describe("CloudOrgService", () => {
  function build(opts: {
    identity?: Partial<{ get: jest.Mock; updateActiveOrg: jest.Mock }>;
    cloud?: Partial<{ post: jest.Mock; get: jest.Mock; del: jest.Mock }>;
  }) {
    const identity = {
      get: jest.fn().mockResolvedValue({ deviceToken: "ct-1" }),
      updateActiveOrg: jest.fn().mockResolvedValue(undefined),
      ...opts.identity,
    };
    const cloud = {
      post: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      ...opts.cloud,
    };
    const imRelay = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };
    const account = new AccountContextService();
    return {
      svc: new CloudOrgService(
        cloud as never,
        identity as never,
        imRelay as never,
        account,
      ),
      identity,
      cloud,
      imRelay,
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

  it("createOrg 成功后用响应直接写活跃组织镜像（owner），无 profile 往返", async () => {
    const { svc, identity, cloud, account } = build({
      cloud: {
        post: jest
          .fn()
          .mockResolvedValue({ id: "o1", name: "Acme", role: "owner" }),
        get: jest.fn(),
      },
    });
    const out = await account.run(USER, () => svc.createOrg("Acme"));
    expect(out).toMatchObject({ id: "o1", name: "Acme" });
    expect(identity.updateActiveOrg).toHaveBeenCalledWith(
      USER,
      "o1",
      "Acme",
      "owner",
    );
    expect(cloud.get).not.toHaveBeenCalled();
  });

  it("acceptInvitation 成功后写活跃组织镜像（member）", async () => {
    const { svc, identity, account } = build({
      cloud: {
        post: jest.fn().mockResolvedValue({ orgId: "o2", orgName: "Beta" }),
      },
    });
    const out = await account.run(USER, () =>
      svc.acceptInvitation("invite-token"),
    );
    expect(out).toEqual({ orgId: "o2", orgName: "Beta" });
    expect(identity.updateActiveOrg).toHaveBeenCalledWith(
      USER,
      "o2",
      "Beta",
      "member",
    );
  });
});
