import { Test } from "@nestjs/testing";
import { AssetService } from "@meshbot/assets";
import { MainErrorCode } from "../errors/main.error-codes";
import type { CloudNode } from "../entities/cloud-node.entity";
import type { CloudNodeGrant } from "../entities/cloud-node-grant.entity";
import { CloudNodeGrantService } from "./cloud-node-grant.service";
import { CloudNodeService } from "./cloud-node.service";
import { CloudDriveService } from "./cloud-drive.service";

// ─────────────────────── helpers ────────────────────────────────────────────

let _idCounter = 1;
function nextId(): string {
  return String(100000000000000000n + BigInt(_idCounter++));
}

function makeNode(overrides: Partial<CloudNode> = {}): CloudNode {
  return {
    id: nextId(),
    orgId: "org1",
    ownerUserId: "u1",
    parentId: null,
    type: "folder",
    name: "root",
    assetKey: null,
    sizeBytes: 0,
    mime: null,
    checksum: null,
    status: "ready",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CloudNode;
}

function makeFile(overrides: Partial<CloudNode> = {}): CloudNode {
  return makeNode({
    type: "file",
    assetKey: "drive/org1/abc",
    mime: "application/octet-stream",
    ...overrides,
  });
}

// ─────────────────────── constants ──────────────────────────────────────────

const QUOTA = 5 * 1024 ** 3;
const ctx = { userId: "u1", orgId: "org1" };

// ─────────────────────── suite ──────────────────────────────────────────────

describe("CloudDriveService", () => {
  let svc: CloudDriveService;
  let nodeSvc: jest.Mocked<CloudNodeService>;
  let grantSvc: jest.Mocked<CloudNodeGrantService>;
  let assetSvc: jest.Mocked<AssetService>;

  beforeEach(async () => {
    _idCounter = 1;
    const module = await Test.createTestingModule({
      providers: [
        CloudDriveService,
        {
          provide: CloudNodeService,
          useValue: {
            findById: jest.fn(),
            listChildren: jest.fn(),
            listAncestors: jest.fn(),
            createFolderRow: jest.fn(),
            createUploadingRow: jest.fn(),
            markReady: jest.fn(),
            rename: jest.fn(),
            move: jest.fn(),
            delete: jest.fn(),
            nameExists: jest.fn(),
            sumOrgReadySize: jest.fn(),
            deleteSubtreeInTx: jest.fn(),
          } as Partial<CloudNodeService>,
        },
        {
          provide: CloudNodeGrantService,
          useValue: {
            listForNodes: jest.fn(),
            listForNode: jest.fn(),
            replaceForNode: jest.fn(),
            deleteForNode: jest.fn(),
            listByGrantee: jest.fn(),
          } as Partial<CloudNodeGrantService>,
        },
        {
          provide: AssetService,
          useValue: {
            getUploadUrl: jest.fn(),
            getSignedUrl: jest.fn(),
            stat: jest.fn(),
            delete: jest.fn(),
          } as Partial<AssetService>,
        },
      ],
    }).compile();

    svc = module.get(CloudDriveService);
    nodeSvc = module.get(CloudNodeService) as jest.Mocked<CloudNodeService>;
    grantSvc = module.get(
      CloudNodeGrantService,
    ) as jest.Mocked<CloudNodeGrantService>;
    assetSvc = module.get(AssetService) as jest.Mocked<AssetService>;

    // 默认返回空数组，避免 undefined 报错
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]);
    nodeSvc.sumOrgReadySize.mockResolvedValue(0);
  });

  // ─── requestUpload ────────────────────────────────────────────────────────

  it("requestUpload 父无 editor 权限 → DRIVE_FORBIDDEN", async () => {
    const parent = makeNode({ id: "p1", ownerUserId: "other" });
    nodeSvc.findById.mockResolvedValueOnce(parent);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]); // 无 grant

    await expect(
      svc.requestUpload(ctx, {
        name: "file.txt",
        parentId: "p1",
        size: 100,
        mime: "text/plain",
      }),
    ).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_FORBIDDEN.code },
    });
  });

  it("requestUpload 配额超 → DRIVE_QUOTA_EXCEEDED", async () => {
    const parent = makeNode({ id: "p1", ownerUserId: "u1" }); // owner 自己 → editor 权限
    nodeSvc.findById.mockResolvedValueOnce(parent);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]);
    nodeSvc.sumOrgReadySize.mockResolvedValue(QUOTA - 10);

    await expect(
      svc.requestUpload(ctx, {
        name: "big",
        parentId: "p1",
        size: 100,
        mime: "text/plain",
      }),
    ).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_QUOTA_EXCEEDED.code },
    });
  });

  it("requestUpload 正常 → 调 createUploadingRow + getUploadUrl，返回 nodeId+putUrl", async () => {
    const parent = makeNode({ id: "p1", ownerUserId: "u1" });
    const newNode = makeFile({
      id: "n1",
      orgId: "org1",
      ownerUserId: "u1",
      parentId: "p1",
      name: "file.txt",
      status: "uploading",
      assetKey: "drive/org1/n1",
    });
    nodeSvc.findById.mockResolvedValueOnce(parent);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]);
    nodeSvc.sumOrgReadySize.mockResolvedValue(0);
    nodeSvc.createUploadingRow.mockResolvedValue(newNode);
    assetSvc.getUploadUrl.mockResolvedValue("https://minio/put-url");

    const result = await svc.requestUpload(ctx, {
      name: "file.txt",
      parentId: "p1",
      size: 100,
      mime: "text/plain",
    });

    expect(nodeSvc.createUploadingRow).toHaveBeenCalledWith(
      "org1",
      "u1",
      "p1",
      "file.txt",
      "text/plain",
    );
    expect(assetSvc.getUploadUrl).toHaveBeenCalledWith("drive/org1/n1", 3600);
    expect(result).toEqual({ nodeId: "n1", putUrl: "https://minio/put-url" });
  });

  // ─── completeUpload ───────────────────────────────────────────────────────

  it("completeUpload 正常 → stat → markReady", async () => {
    const node = makeFile({
      id: "n1",
      orgId: "org1",
      ownerUserId: "u1",
      status: "uploading",
      assetKey: "drive/org1/n1",
    });
    const readyNode = { ...node, status: "ready" as const, sizeBytes: 500 };
    nodeSvc.findById
      .mockResolvedValueOnce(node)
      .mockResolvedValueOnce(readyNode as CloudNode);
    assetSvc.stat.mockResolvedValue({ size: 500 });
    nodeSvc.sumOrgReadySize.mockResolvedValue(0);
    nodeSvc.markReady.mockResolvedValue(undefined);

    const view = await svc.completeUpload(ctx, "n1", "checksum123");

    expect(assetSvc.stat).toHaveBeenCalledWith("drive/org1/n1");
    expect(nodeSvc.markReady).toHaveBeenCalledWith("n1", 500, "checksum123");
    expect(view.status).toBe("ready");
  });

  it("completeUpload 无 checksum → markReady 传 null", async () => {
    const node = makeFile({
      id: "n2",
      orgId: "org1",
      ownerUserId: "u1",
      status: "uploading",
      assetKey: "drive/org1/n2",
    });
    const readyNode = { ...node, status: "ready" as const, sizeBytes: 200 };
    nodeSvc.findById
      .mockResolvedValueOnce(node)
      .mockResolvedValueOnce(readyNode as CloudNode);
    assetSvc.stat.mockResolvedValue({ size: 200 });
    nodeSvc.sumOrgReadySize.mockResolvedValue(0);
    nodeSvc.markReady.mockResolvedValue(undefined);

    await svc.completeUpload(ctx, "n2"); // 不传 checksum

    expect(nodeSvc.markReady).toHaveBeenCalledWith("n2", 200, null);
  });

  it("completeUpload stat 后超配额 → 先删 node 再删 asset + DRIVE_QUOTA_EXCEEDED（I2）", async () => {
    const node = makeFile({
      id: "n1",
      orgId: "org1",
      ownerUserId: "u1",
      status: "uploading",
      assetKey: "drive/org1/n1",
    });
    nodeSvc.findById.mockResolvedValueOnce(node);
    assetSvc.stat.mockResolvedValue({ size: 100 });
    nodeSvc.sumOrgReadySize.mockResolvedValue(QUOTA - 50); // 50 剩余，文件 100 → 超
    nodeSvc.delete.mockResolvedValue(undefined);
    assetSvc.delete.mockResolvedValue(undefined);

    await expect(svc.completeUpload(ctx, "n1")).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_QUOTA_EXCEEDED.code },
    });

    // I2：先删 DB node（主数据），再 best-effort 删 Minio 对象
    const nodeDeleteOrder = nodeSvc.delete.mock.invocationCallOrder[0];
    const assetDeleteOrder = assetSvc.delete.mock.invocationCallOrder[0];
    expect(nodeDeleteOrder).toBeLessThan(assetDeleteOrder);
    expect(nodeSvc.delete).toHaveBeenCalledWith("n1");
    expect(assetSvc.delete).toHaveBeenCalledWith("drive/org1/n1");
  });

  // ─── getDownloadUrl ───────────────────────────────────────────────────────

  it("getDownloadUrl uploading 节点 → DRIVE_NOT_READY", async () => {
    const node = makeFile({
      id: "n1",
      orgId: "org1",
      ownerUserId: "u1",
      status: "uploading",
      assetKey: "drive/org1/n1",
    });
    nodeSvc.findById.mockResolvedValueOnce(node);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]);

    await expect(svc.getDownloadUrl(ctx, "n1")).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_NOT_READY.code },
    });
  });

  it("getDownloadUrl viewer 权限 → 调 getSignedUrl 返回 url", async () => {
    const viewerCtx = { userId: "viewer1", orgId: "org1" };
    const node = makeFile({
      id: "n1",
      orgId: "org1",
      ownerUserId: "u1",
      status: "ready",
      assetKey: "drive/org1/n1",
    });
    const grant: CloudNodeGrant = {
      id: "g1",
      nodeId: "n1",
      granteeType: "user",
      granteeId: "viewer1",
      permission: "viewer",
      createdAt: new Date(),
    } as CloudNodeGrant;
    nodeSvc.findById.mockResolvedValueOnce(node);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([grant]);
    assetSvc.getSignedUrl.mockResolvedValue("https://minio/signed-url");

    const result = await svc.getDownloadUrl(viewerCtx, "n1");

    expect(assetSvc.getSignedUrl).toHaveBeenCalledWith("drive/org1/n1", 3600, {
      contentType: "application/octet-stream",
      fileName: "root",
      disposition: "inline",
    });
    expect(result.url).toBe("https://minio/signed-url");
    expect(result.ttl).toBe(3600);
  });

  // ─── move ─────────────────────────────────────────────────────────────────

  it("move 目标是自身子孙 → DRIVE_INVALID_MOVE", async () => {
    const nodeToMove = makeNode({ id: "n1", ownerUserId: "u1" });
    const targetParent = makeNode({ id: "child1", ownerUserId: "u1" });
    // 调用顺序：
    // 1. requirePermission(n1, "editor") → listAncestors(n1) → []
    // 2. requirePermission(child1, "editor") → listAncestors(child1) → []
    // 3. 防环检查 listAncestors(child1) → [nodeToMove]（包含被移动节点）
    nodeSvc.findById
      .mockResolvedValueOnce(nodeToMove) // 查 n1
      .mockResolvedValueOnce(targetParent); // 查 child1
    nodeSvc.listAncestors
      .mockResolvedValueOnce([]) // requirePermission(n1) 用
      .mockResolvedValueOnce([]) // requirePermission(child1) 用
      .mockResolvedValueOnce([nodeToMove]); // 防环检查：child1 的祖先链包含 n1
    grantSvc.listForNodes.mockResolvedValue([]);

    await expect(svc.move(ctx, "n1", "child1")).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_INVALID_MOVE.code },
    });
  });

  it("move 目标是自身 → DRIVE_INVALID_MOVE", async () => {
    const node = makeNode({ id: "n1", ownerUserId: "u1" });
    nodeSvc.findById.mockResolvedValueOnce(node);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]);

    await expect(svc.move(ctx, "n1", "n1")).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_INVALID_MOVE.code },
    });
  });

  // ─── createFolder ─────────────────────────────────────────────────────────

  it("createFolder 同名 → DRIVE_NAME_CONFLICT", async () => {
    const parent = makeNode({ id: "p1", ownerUserId: "u1" });
    nodeSvc.findById.mockResolvedValueOnce(parent);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]);
    nodeSvc.nameExists.mockResolvedValue(true);

    await expect(svc.createFolder(ctx, "p1", "dup")).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_NAME_CONFLICT.code },
    });
  });

  it("createFolder 正常 → 返回 NodeView", async () => {
    const parent = makeNode({ id: "p1", ownerUserId: "u1" });
    const created = makeNode({
      id: "new1",
      ownerUserId: "u1",
      parentId: "p1",
      name: "new-folder",
    });
    nodeSvc.findById.mockResolvedValueOnce(parent);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]);
    nodeSvc.nameExists.mockResolvedValue(false);
    nodeSvc.createFolderRow.mockResolvedValue(created);

    const view = await svc.createFolder(ctx, "p1", "new-folder");

    expect(view.id).toBe("new1");
    expect(view.type).toBe("folder");
    expect(view.permission).toBe("owner");
  });

  // ─── listNodes ────────────────────────────────────────────────────────────

  it("listNodes(null) 只返回 ownerUserId 匹配的根节点", async () => {
    const mine = makeNode({ id: "r1", ownerUserId: "u1", parentId: null });
    const others = makeNode({ id: "r2", ownerUserId: "other", parentId: null });
    nodeSvc.listChildren.mockResolvedValueOnce([mine, others]);

    const views = await svc.listNodes(ctx, null);

    expect(views).toHaveLength(1);
    expect(views[0].id).toBe("r1");
    expect(views[0].permission).toBe("owner");
    // 不应查父节点也不应查 grant
    expect(nodeSvc.findById).not.toHaveBeenCalled();
    expect(grantSvc.listForNodes).not.toHaveBeenCalled();
  });

  it("listNodes(null) 无根节点 → 空数组", async () => {
    nodeSvc.listChildren.mockResolvedValueOnce([]);

    const views = await svc.listNodes(ctx, null);

    expect(views).toHaveLength(0);
  });

  it("listNodes 父节点无 viewer 权限 → DRIVE_FORBIDDEN", async () => {
    const parent = makeNode({ id: "p1", ownerUserId: "other" });
    nodeSvc.findById.mockResolvedValueOnce(parent);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]); // 无 grant

    await expect(svc.listNodes(ctx, "p1")).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_FORBIDDEN.code },
    });
  });

  it("listNodes 正常 → 返回子节点列表", async () => {
    const parent = makeNode({ id: "p1", ownerUserId: "u1" });
    const child1 = makeNode({ id: "c1", ownerUserId: "u1", parentId: "p1" });
    const child2 = makeFile({
      id: "c2",
      ownerUserId: "u1",
      parentId: "p1",
      status: "ready",
    });
    nodeSvc.findById.mockResolvedValueOnce(parent);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]); // owner 自己，无需 grant
    nodeSvc.listChildren.mockResolvedValue([child1, child2]);
    // 为每个子节点的 listAncestors 调用返回空数组
    nodeSvc.listAncestors.mockResolvedValue([]);

    const views = await svc.listNodes(ctx, "p1");

    expect(views).toHaveLength(2);
    expect(views.map((v) => v.id)).toContain("c1");
    expect(views.map((v) => v.id)).toContain("c2");
  });

  // ─── quota ────────────────────────────────────────────────────────────────

  it("quota 返回 used + limit", async () => {
    nodeSvc.sumOrgReadySize.mockResolvedValue(1024);

    const result = await svc.quota(ctx);

    expect(result.used).toBe(1024);
    expect(result.limit).toBe(QUOTA);
  });

  // ─── deleteNode ───────────────────────────────────────────────────────────

  it("deleteNode 无 editor 权限 → DRIVE_FORBIDDEN（C1）", async () => {
    const node = makeNode({ id: "n1", ownerUserId: "other" });
    nodeSvc.findById.mockResolvedValueOnce(node);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]); // 无任何 grant → forbidden

    await expect(svc.deleteNode(ctx, "n1")).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_FORBIDDEN.code },
    });
    expect(nodeSvc.deleteSubtreeInTx).not.toHaveBeenCalled();
  });

  it("deleteNode 正常 → 调 deleteSubtreeInTx，逐个删 Minio assetKey（C1）", async () => {
    const node = makeNode({ id: "n1", ownerUserId: "u1" });
    const assetKeys = ["drive/org1/file1", "drive/org1/file2"];
    nodeSvc.findById.mockResolvedValueOnce(node);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]);
    nodeSvc.deleteSubtreeInTx.mockResolvedValue(assetKeys);
    assetSvc.delete.mockResolvedValue(undefined);

    await svc.deleteNode(ctx, "n1");

    expect(nodeSvc.deleteSubtreeInTx).toHaveBeenCalledWith("n1");
    expect(assetSvc.delete).toHaveBeenCalledTimes(2);
    expect(assetSvc.delete).toHaveBeenCalledWith("drive/org1/file1");
    expect(assetSvc.delete).toHaveBeenCalledWith("drive/org1/file2");
  });

  it("deleteNode Minio delete 抛错 → 不影响整体成功（best-effort）", async () => {
    const node = makeNode({ id: "n1", ownerUserId: "u1" });
    nodeSvc.findById.mockResolvedValueOnce(node);
    nodeSvc.listAncestors.mockResolvedValue([]);
    grantSvc.listForNodes.mockResolvedValue([]);
    nodeSvc.deleteSubtreeInTx.mockResolvedValue(["drive/org1/file1"]);
    assetSvc.delete.mockRejectedValue(new Error("minio error"));

    // best-effort：Minio 失败不应 throw
    await expect(svc.deleteNode(ctx, "n1")).resolves.toBeUndefined();
  });
});
