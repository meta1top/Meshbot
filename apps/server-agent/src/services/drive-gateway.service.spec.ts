import { AccountContextService } from "@meshbot/agent";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { DriveGatewayService } from "./drive-gateway.service";

/**
 * DriveGatewayService 单测：mock cloud + identity + account，
 * 验证每方法带 token 调对应路径、presigned url 原样透传、无 token → AUTH_UNAUTHORIZED。
 */
describe("DriveGatewayService", () => {
  const TOKEN = "cloud-jwt-abc";

  /** 构造带 cloudToken 的 identity mock */
  function makeIdentity(cloudToken: string | null = TOKEN) {
    return {
      get: jest
        .fn()
        .mockResolvedValue(
          cloudToken != null ? { cloudToken } : { cloudToken: null },
        ),
    };
  }

  /** 构造 cloud mock，方法默认返回空对象 */
  function makeCloud(overrides: Record<string, unknown> = {}) {
    return {
      get: jest.fn().mockResolvedValue(overrides.get ?? {}),
      post: jest.fn().mockResolvedValue(overrides.post ?? {}),
      patch: jest.fn().mockResolvedValue(overrides.patch ?? {}),
      put: jest.fn().mockResolvedValue(overrides.put ?? {}),
      del: jest.fn().mockResolvedValue(overrides.del ?? {}),
    };
  }

  function makeSvc(
    cloud: ReturnType<typeof makeCloud>,
    identity: ReturnType<typeof makeIdentity>,
    userId = "u1",
  ) {
    const account = new AccountContextService();
    const svc = new DriveGatewayService(
      cloud as never,
      identity as never,
      account,
    );
    return { svc, account, userId };
  }

  describe("listNodes", () => {
    it("无 parentId 调 /api/drive/nodes（无 query string）", async () => {
      const cloud = makeCloud();
      const identity = makeIdentity();
      const { svc, account, userId } = makeSvc(cloud, identity);
      await account.run(userId, () => svc.listNodes(null));
      expect(cloud.get).toHaveBeenCalledWith("/api/drive/nodes", TOKEN);
    });

    it("有 parentId 追加 ?parentId=xxx", async () => {
      const cloud = makeCloud();
      const identity = makeIdentity();
      const { svc, account, userId } = makeSvc(cloud, identity);
      await account.run(userId, () => svc.listNodes("folder-1"));
      expect(cloud.get).toHaveBeenCalledWith(
        "/api/drive/nodes?parentId=folder-1",
        TOKEN,
      );
    });
  });

  describe("listShared", () => {
    it("调 /api/drive/shared", async () => {
      const cloud = makeCloud();
      const identity = makeIdentity();
      const { svc, account, userId } = makeSvc(cloud, identity);
      await account.run(userId, () => svc.listShared());
      expect(cloud.get).toHaveBeenCalledWith("/api/drive/shared", TOKEN);
    });
  });

  describe("getQuota", () => {
    it("调 /api/drive/quota", async () => {
      const cloud = makeCloud();
      const identity = makeIdentity();
      const { svc, account, userId } = makeSvc(cloud, identity);
      await account.run(userId, () => svc.getQuota());
      expect(cloud.get).toHaveBeenCalledWith("/api/drive/quota", TOKEN);
    });
  });

  describe("createFolder", () => {
    it("POST /api/drive/folders 带 body", async () => {
      const cloud = makeCloud();
      const identity = makeIdentity();
      const { svc, account, userId } = makeSvc(cloud, identity);
      const body = { name: "新文件夹", parentId: null };
      await account.run(userId, () => svc.createFolder(body));
      expect(cloud.post).toHaveBeenCalledWith(
        "/api/drive/folders",
        body,
        TOKEN,
      );
    });
  });

  describe("requestUpload", () => {
    it("POST /api/drive/uploads 返回含 putUrl 的响应原样透传", async () => {
      const putUrlResponse = {
        nodeId: "n1",
        putUrl: "https://s3.example.com/presigned?sig=xxx",
      };
      const cloud = makeCloud({ post: putUrlResponse });
      const identity = makeIdentity();
      const { svc, account, userId } = makeSvc(cloud, identity);
      const body = { name: "file.txt", size: 1024, mimeType: "text/plain" };
      const result = await account.run(userId, () => svc.requestUpload(body));
      expect(cloud.post).toHaveBeenCalledWith(
        "/api/drive/uploads",
        body,
        TOKEN,
      );
      // presigned putUrl 原样透传
      expect(result).toEqual(putUrlResponse);
    });
  });

  describe("completeUpload", () => {
    it("POST /api/drive/uploads/:nodeId/complete 带 nodeId 路径", async () => {
      const cloud = makeCloud();
      const identity = makeIdentity();
      const { svc, account, userId } = makeSvc(cloud, identity);
      const body = { checksum: "abc123" };
      await account.run(userId, () => svc.completeUpload("n1", body));
      expect(cloud.post).toHaveBeenCalledWith(
        "/api/drive/uploads/n1/complete",
        body,
        TOKEN,
      );
    });
  });

  describe("getFileUrl", () => {
    it("GET /api/drive/files/:id/url 返回含 url 的响应原样透传", async () => {
      const urlResponse = { url: "https://s3.example.com/download?sig=yyy" };
      const cloud = makeCloud({ get: urlResponse });
      const identity = makeIdentity();
      const { svc, account, userId } = makeSvc(cloud, identity);
      const result = await account.run(userId, () => svc.getFileUrl("f1"));
      expect(cloud.get).toHaveBeenCalledWith("/api/drive/files/f1/url", TOKEN);
      // presigned url 原样透传
      expect(result).toEqual(urlResponse);
    });
  });

  describe("updateNode", () => {
    it("PATCH /api/drive/nodes/:id 带 body", async () => {
      const cloud = makeCloud();
      const identity = makeIdentity();
      const { svc, account, userId } = makeSvc(cloud, identity);
      const body = { name: "重命名" };
      await account.run(userId, () => svc.updateNode("n1", body));
      expect(cloud.patch).toHaveBeenCalledWith(
        "/api/drive/nodes/n1",
        body,
        TOKEN,
      );
    });
  });

  describe("deleteNode", () => {
    it("DELETE /api/drive/nodes/:id", async () => {
      const cloud = makeCloud();
      const identity = makeIdentity();
      const { svc, account, userId } = makeSvc(cloud, identity);
      await account.run(userId, () => svc.deleteNode("n1"));
      expect(cloud.del).toHaveBeenCalledWith("/api/drive/nodes/n1", TOKEN);
    });
  });

  describe("getGrants", () => {
    it("GET /api/drive/nodes/:id/grants", async () => {
      const cloud = makeCloud();
      const identity = makeIdentity();
      const { svc, account, userId } = makeSvc(cloud, identity);
      await account.run(userId, () => svc.getGrants("n1"));
      expect(cloud.get).toHaveBeenCalledWith(
        "/api/drive/nodes/n1/grants",
        TOKEN,
      );
    });
  });

  describe("setGrants", () => {
    it("PUT /api/drive/nodes/:id/grants 带 body", async () => {
      const cloud = makeCloud();
      const identity = makeIdentity();
      const { svc, account, userId } = makeSvc(cloud, identity);
      const body = { grants: [{ userId: "u2", role: "viewer" }] };
      await account.run(userId, () => svc.setGrants("n1", body));
      expect(cloud.put).toHaveBeenCalledWith(
        "/api/drive/nodes/n1/grants",
        body,
        TOKEN,
      );
    });
  });

  describe("无 cloudToken → AUTH_UNAUTHORIZED", () => {
    it("token 为 null 时 listNodes 抛 AUTH_UNAUTHORIZED", async () => {
      const cloud = makeCloud();
      const identity = makeIdentity(null);
      const { svc, account, userId } = makeSvc(cloud, identity);
      await expect(
        account.run(userId, () => svc.listNodes(null)),
      ).rejects.toMatchObject({ name: "AppError" });
      // 确认错误码（AppError 的 code 在 errorCode.code 字段）
      await expect(
        account.run(userId, () => svc.listNodes(null)),
      ).rejects.toMatchObject({
        errorCode: { code: AgentErrorCode.AUTH_UNAUTHORIZED.code },
      });
    });

    it("identity 返回 null 时 requestUpload 抛 AUTH_UNAUTHORIZED", async () => {
      const cloud = makeCloud();
      const identity = { get: jest.fn().mockResolvedValue(null) };
      const { svc, account, userId } = makeSvc(cloud, identity as never);
      await expect(
        account.run(userId, () => svc.requestUpload({})),
      ).rejects.toMatchObject({ name: "AppError" });
    });
  });
});
