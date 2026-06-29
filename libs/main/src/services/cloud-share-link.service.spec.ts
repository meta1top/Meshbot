import * as bcrypt from "bcrypt";
import type { Repository } from "typeorm";
import { IsNull } from "typeorm";
import { CloudShareLink } from "../entities/cloud-share-link.entity";
import type { CloudNode } from "../entities/cloud-node.entity";
import { MainErrorCode } from "../errors/main.error-codes";
import { CloudShareLinkService } from "./cloud-share-link.service";
import type { CloudNodeService } from "./cloud-node.service";
import type { AssetService } from "@meshbot/assets";

/** 构造一个 ready file CloudNode mock */
function makeFileNode(overrides: Partial<CloudNode> = {}): CloudNode {
  return {
    id: "node-1",
    orgId: "org-1",
    ownerUserId: "user-1",
    type: "file",
    status: "ready",
    name: "test.txt",
    mime: "text/plain",
    sizeBytes: 1024,
    assetKey: "bucket/key",
    parentId: null,
    checksum: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CloudNode;
}

/** 构造一个 CloudShareLink mock */
function makeLink(overrides: Partial<CloudShareLink> = {}): CloudShareLink {
  return {
    id: "link-1",
    token: "abc12345",
    nodeId: "node-1",
    orgId: "org-1",
    createdByUserId: "user-1",
    passwordHash: null,
    expiresAt: null,
    createdAt: new Date(),
    revokedAt: null,
    ...overrides,
  } as CloudShareLink;
}

describe("CloudShareLinkService", () => {
  let service: CloudShareLinkService;
  let repo: jest.Mocked<Repository<CloudShareLink>>;
  let nodeSvc: jest.Mocked<CloudNodeService>;
  let assetSvc: jest.Mocked<AssetService>;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<Repository<CloudShareLink>>;

    nodeSvc = {
      findById: jest.fn(),
    } as unknown as jest.Mocked<CloudNodeService>;

    assetSvc = {
      getSignedUrl: jest.fn(),
    } as unknown as jest.Mocked<AssetService>;

    service = new CloudShareLinkService(repo, nodeSvc, assetSvc);
  });

  // ── create ──────────────────────────────────────────────────────────────────

  describe("create", () => {
    it("owner 文件 → 生成 token(12位) + 入库", async () => {
      const node = makeFileNode();
      nodeSvc.findById.mockResolvedValue(node);
      const link = makeLink();
      repo.create.mockReturnValue(link);
      repo.save.mockResolvedValue(link);

      const result = await service.create({ userId: "user-1" }, "node-1", {});

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          token: expect.any(String),
          nodeId: "node-1",
          orgId: "org-1",
          createdByUserId: "user-1",
          passwordHash: null,
          expiresAt: null,
          revokedAt: null,
        }),
      );
      // token 长度：randomBytes(9).toString("base64url") → 12 chars
      const callArgs = repo.create.mock.calls[0][0] as Partial<CloudShareLink>;
      expect(callArgs.token).toHaveLength(12);
      expect(result).toBe(link);
    });

    it("非 owner → 抛 DRIVE_FORBIDDEN", async () => {
      const node = makeFileNode({ ownerUserId: "other-user" });
      nodeSvc.findById.mockResolvedValue(node);

      await expect(
        service.create({ userId: "user-1" }, "node-1", {}),
      ).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_FORBIDDEN.code },
      });
    });

    it("非 file 节点 → 抛 DRIVE_NODE_NOT_FOUND", async () => {
      const node = makeFileNode({ type: "folder" });
      nodeSvc.findById.mockResolvedValue(node);

      await expect(
        service.create({ userId: "user-1" }, "node-1", {}),
      ).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_NODE_NOT_FOUND.code },
      });
    });

    it("status 非 ready → 抛 DRIVE_NODE_NOT_FOUND", async () => {
      const node = makeFileNode({ status: "uploading" });
      nodeSvc.findById.mockResolvedValue(node);

      await expect(
        service.create({ userId: "user-1" }, "node-1", {}),
      ).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_NODE_NOT_FOUND.code },
      });
    });

    it("节点不存在 → 抛 DRIVE_NODE_NOT_FOUND", async () => {
      nodeSvc.findById.mockResolvedValue(null);

      await expect(
        service.create({ userId: "user-1" }, "node-1", {}),
      ).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_NODE_NOT_FOUND.code },
      });
    });

    it("带 password → passwordHash 非空且 bcrypt.compare 通过", async () => {
      const node = makeFileNode();
      nodeSvc.findById.mockResolvedValue(node);
      let capturedHash = "";
      repo.create.mockImplementation((data) => {
        capturedHash = (data as Partial<CloudShareLink>).passwordHash ?? "";
        return data as CloudShareLink;
      });
      repo.save.mockImplementation(async (data) => data as CloudShareLink);

      await service.create({ userId: "user-1" }, "node-1", {
        password: "secret123",
      });

      expect(capturedHash).toBeTruthy();
      const valid = await bcrypt.compare("secret123", capturedHash);
      expect(valid).toBe(true);
    });

    it("带 expiresInDays=7 → expiresAt 约 now+7d", async () => {
      const node = makeFileNode();
      nodeSvc.findById.mockResolvedValue(node);
      const before = Date.now();
      let capturedExpiresAt: Date | null = null;
      repo.create.mockImplementation((data) => {
        capturedExpiresAt = (data as Partial<CloudShareLink>).expiresAt ?? null;
        return data as CloudShareLink;
      });
      repo.save.mockImplementation(async (data) => data as CloudShareLink);

      await service.create({ userId: "user-1" }, "node-1", {
        expiresInDays: 7,
      });

      expect(capturedExpiresAt).not.toBeNull();
      const ms = (capturedExpiresAt as unknown as Date).getTime();
      const expected7d = before + 7 * 86_400_000;
      // 允许 1 秒误差
      expect(ms).toBeGreaterThanOrEqual(expected7d - 1000);
      expect(ms).toBeLessThanOrEqual(expected7d + 1000);
    });
  });

  // ── resolveOrThrow ──────────────────────────────────────────────────────────

  describe("resolveOrThrow", () => {
    it("有效链接 → 返回 {link, node}", async () => {
      const link = makeLink();
      const node = makeFileNode();
      repo.findOne.mockResolvedValue(link);
      nodeSvc.findById.mockResolvedValue(node);

      const result = await service.resolveOrThrow("abc12345");

      expect(result).toEqual({ link, node });
    });

    it("link 不存在 → 抛 DRIVE_SHARE_NOT_FOUND", async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.resolveOrThrow("no-such")).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_SHARE_NOT_FOUND.code },
      });
    });

    it("link 已撤销 → 抛 DRIVE_SHARE_NOT_FOUND", async () => {
      const link = makeLink({ revokedAt: new Date() });
      repo.findOne.mockResolvedValue(link);

      await expect(service.resolveOrThrow("abc12345")).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_SHARE_NOT_FOUND.code },
      });
    });

    it("link 已过期 → 抛 DRIVE_SHARE_EXPIRED", async () => {
      const link = makeLink({
        expiresAt: new Date(Date.now() - 1000),
      });
      repo.findOne.mockResolvedValue(link);

      await expect(service.resolveOrThrow("abc12345")).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_SHARE_EXPIRED.code },
      });
    });

    it("node 不存在 → 抛 DRIVE_SHARE_NOT_FOUND", async () => {
      const link = makeLink();
      repo.findOne.mockResolvedValue(link);
      nodeSvc.findById.mockResolvedValue(null);

      await expect(service.resolveOrThrow("abc12345")).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_SHARE_NOT_FOUND.code },
      });
    });

    it("node status 非 ready → 抛 DRIVE_SHARE_NOT_FOUND", async () => {
      const link = makeLink();
      const node = makeFileNode({ status: "uploading" });
      repo.findOne.mockResolvedValue(link);
      nodeSvc.findById.mockResolvedValue(node);

      await expect(service.resolveOrThrow("abc12345")).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_SHARE_NOT_FOUND.code },
      });
    });
  });

  // ── verifyPassword ──────────────────────────────────────────────────────────

  describe("verifyPassword", () => {
    it("无 passwordHash → 返回 true（任意密码）", async () => {
      const link = makeLink({ passwordHash: null });
      expect(await service.verifyPassword(link)).toBe(true);
      expect(await service.verifyPassword(link, "anything")).toBe(true);
    });

    it("有 passwordHash → 密码正确返回 true", async () => {
      const hash = await bcrypt.hash("correct", 4);
      const link = makeLink({ passwordHash: hash });
      expect(await service.verifyPassword(link, "correct")).toBe(true);
    });

    it("有 passwordHash → 密码错误返回 false", async () => {
      const hash = await bcrypt.hash("correct", 4);
      const link = makeLink({ passwordHash: hash });
      expect(await service.verifyPassword(link, "wrong")).toBe(false);
    });

    it("有 passwordHash → 不传密码返回 false", async () => {
      const hash = await bcrypt.hash("correct", 4);
      const link = makeLink({ passwordHash: hash });
      expect(await service.verifyPassword(link)).toBe(false);
    });
  });

  // ── revoke ──────────────────────────────────────────────────────────────────

  describe("revoke", () => {
    it("owner → 置 revokedAt", async () => {
      const link = makeLink();
      const node = makeFileNode();
      repo.findOne.mockResolvedValue(link);
      nodeSvc.findById.mockResolvedValue(node);
      repo.update.mockResolvedValue({ affected: 1 } as never);

      await service.revoke({ userId: "user-1" }, "link-1");

      expect(repo.update).toHaveBeenCalledWith(
        { id: "link-1" },
        { revokedAt: expect.any(Date) },
      );
    });

    it("非 owner → 抛 DRIVE_FORBIDDEN", async () => {
      const link = makeLink();
      const node = makeFileNode({ ownerUserId: "other-user" });
      repo.findOne.mockResolvedValue(link);
      nodeSvc.findById.mockResolvedValue(node);

      await expect(
        service.revoke({ userId: "user-1" }, "link-1"),
      ).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_FORBIDDEN.code },
      });
    });

    it("link 不存在 → 抛 DRIVE_SHARE_NOT_FOUND", async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.revoke({ userId: "user-1" }, "no-link"),
      ).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_SHARE_NOT_FOUND.code },
      });
    });
  });

  // ── listForNode ─────────────────────────────────────────────────────────────

  describe("listForNode", () => {
    it("owner → 仅返回未撤销的链接", async () => {
      const node = makeFileNode();
      nodeSvc.findById.mockResolvedValue(node);
      const links = [makeLink()];
      repo.find.mockResolvedValue(links);

      const result = await service.listForNode({ userId: "user-1" }, "node-1");

      expect(repo.find).toHaveBeenCalledWith({
        where: { nodeId: "node-1", revokedAt: IsNull() },
        order: { createdAt: "DESC" },
      });
      expect(result).toBe(links);
    });

    it("非 owner → 抛 DRIVE_FORBIDDEN", async () => {
      const node = makeFileNode({ ownerUserId: "other-user" });
      nodeSvc.findById.mockResolvedValue(node);

      await expect(
        service.listForNode({ userId: "user-1" }, "node-1"),
      ).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_FORBIDDEN.code },
      });
    });

    it("node 不存在 → 抛 DRIVE_FORBIDDEN", async () => {
      nodeSvc.findById.mockResolvedValue(null);

      await expect(
        service.listForNode({ userId: "user-1" }, "node-1"),
      ).rejects.toMatchObject({
        errorCode: { code: MainErrorCode.DRIVE_FORBIDDEN.code },
      });
    });
  });

  // ── signDownload ────────────────────────────────────────────────────────────

  describe("signDownload", () => {
    it("返回 presigned url + name + mime", async () => {
      const node = makeFileNode();
      assetSvc.getSignedUrl.mockResolvedValue("https://example.com/signed");

      const result = await service.signDownload(node);

      expect(assetSvc.getSignedUrl).toHaveBeenCalledWith("bucket/key", 3600, {
        contentType: "text/plain",
        fileName: "test.txt",
        disposition: "inline",
      });
      expect(result).toEqual({
        url: "https://example.com/signed",
        name: "test.txt",
        mime: "text/plain",
      });
    });
  });
});
