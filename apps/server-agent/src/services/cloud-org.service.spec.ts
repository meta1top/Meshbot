import { AgentErrorCode } from "../errors/agent.error-codes";
import { CloudOrgService } from "./cloud-org.service";

describe("CloudOrgService", () => {
  function build(opts: {
    identity?: Partial<{ get: jest.Mock; updateActiveOrg: jest.Mock }>;
    cloud?: Partial<{ post: jest.Mock; get: jest.Mock; del: jest.Mock }>;
  }) {
    const identity = {
      get: jest.fn().mockResolvedValue({ cloudToken: "ct-1" }),
      updateActiveOrg: jest.fn().mockResolvedValue(undefined),
      ...opts.identity,
    };
    const cloud = {
      post: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      ...opts.cloud,
    };
    return {
      svc: new CloudOrgService(cloud as never, identity as never),
      identity,
      cloud,
    };
  }

  it("无云端 token → AUTH_UNAUTHORIZED", async () => {
    const { svc } = build({
      identity: { get: jest.fn().mockResolvedValue(null) },
    });
    await expect(svc.listMine()).rejects.toMatchObject({
      errorCode: AgentErrorCode.AUTH_UNAUTHORIZED,
    });
  });

  it("createOrg 成功后用响应直接写活跃组织镜像（owner），无 profile 往返", async () => {
    const { svc, identity, cloud } = build({
      cloud: {
        post: jest
          .fn()
          .mockResolvedValue({ id: "o1", name: "Acme", role: "owner" }),
        get: jest.fn(),
      },
    });
    const out = await svc.createOrg("Acme");
    expect(out).toMatchObject({ id: "o1", name: "Acme" });
    expect(identity.updateActiveOrg).toHaveBeenCalledWith(
      "o1",
      "Acme",
      "owner",
    );
    expect(cloud.get).not.toHaveBeenCalled();
  });

  it("acceptInvitation 成功后写活跃组织镜像（member）", async () => {
    const { svc, identity } = build({
      cloud: {
        post: jest.fn().mockResolvedValue({ orgId: "o2", orgName: "Beta" }),
      },
    });
    const out = await svc.acceptInvitation("invite-token");
    expect(out).toEqual({ orgId: "o2", orgName: "Beta" });
    expect(identity.updateActiveOrg).toHaveBeenCalledWith(
      "o2",
      "Beta",
      "member",
    );
  });
});
