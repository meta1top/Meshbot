import { Repository } from "typeorm";
import { CloudNode } from "../entities/cloud-node.entity";
import { CloudNodeGrant } from "../entities/cloud-node-grant.entity";
import { CloudNodeService } from "./cloud-node.service";
import { CloudNodeGrantService } from "./cloud-node-grant.service";

// ─────────────────────────── helpers ───────────────────────────────────────

let _idCounter = 1;
/** 生成测试用伪雪花 id。 */
function nextId(): string {
  return String(100000000000000000n + BigInt(_idCounter++));
}

function makeNode(overrides: Partial<CloudNode> = {}): CloudNode {
  return {
    id: nextId(),
    orgId: "o1",
    ownerUserId: "u1",
    parentId: null,
    type: "folder",
    name: "test",
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

function makeGrant(overrides: Partial<CloudNodeGrant> = {}): CloudNodeGrant {
  return {
    id: nextId(),
    nodeId: "n1",
    granteeType: "user",
    granteeId: "u2",
    permission: "viewer",
    createdAt: new Date(),
    ...overrides,
  } as CloudNodeGrant;
}

// ─── fake DataSource（供 @Transactional() root 路径使用）──────────────────

function makeFakeDataSource() {
  return {
    createQueryRunner: () => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

// ─────────────────── CloudNodeService repo mock ────────────────────────────

function makeNodeRepo(
  overrides: Partial<Record<string, jest.Mock>> = {},
): Repository<CloudNode> {
  return Object.assign(Object.create(Repository.prototype), {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    findOneBy: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    create: jest
      .fn()
      .mockImplementation((data: Partial<CloudNode>) => ({ ...data })),
    save: jest
      .fn()
      .mockImplementation((entity: Partial<CloudNode>) =>
        Promise.resolve({ id: nextId(), ...entity }),
      ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ total: "0" }),
    }),
    manager: { connection: makeFakeDataSource() },
    ...overrides,
  }) as unknown as Repository<CloudNode>;
}

// ─────────────────── CloudNodeGrantService repo mock ───────────────────────

function makeGrantRepo(
  overrides: Partial<Record<string, jest.Mock>> = {},
): Repository<CloudNodeGrant> {
  return Object.assign(Object.create(Repository.prototype), {
    find: jest.fn().mockResolvedValue([]),
    create: jest
      .fn()
      .mockImplementation((data: Partial<CloudNodeGrant>) => ({ ...data })),
    save: jest
      .fn()
      .mockImplementation((entities: unknown) => Promise.resolve(entities)),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: { connection: makeFakeDataSource() },
    ...overrides,
  }) as unknown as Repository<CloudNodeGrant>;
}

/** 构造 CloudNodeGrantService stub（供 CloudNodeService 注入）。 */
function makeGrantSvc(
  overrides: Partial<CloudNodeGrantService> = {},
): CloudNodeGrantService {
  return {
    deleteForNode: jest.fn().mockResolvedValue(undefined),
    listForNodes: jest.fn().mockResolvedValue([]),
    listForNode: jest.fn().mockResolvedValue([]),
    replaceForNode: jest.fn().mockResolvedValue(undefined),
    listByGrantee: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as CloudNodeGrantService;
}

// ─────────────────────────── CloudNodeService ──────────────────────────────

describe("CloudNodeService", () => {
  beforeEach(() => {
    _idCounter = 1;
  });

  // ── createFolderRow + listChildren ──────────────────────────────────────
  it("createFolderRow 返回 folder+ready，listChildren 包含它", async () => {
    const folderNode = makeNode({
      type: "folder",
      status: "ready",
      name: "docs",
    });
    const repo = makeNodeRepo({
      save: jest.fn().mockResolvedValue(folderNode),
      create: jest.fn().mockReturnValue(folderNode),
      find: jest.fn().mockResolvedValue([folderNode]),
    });
    const svc = new CloudNodeService(repo, makeGrantSvc());

    const f = await svc.createFolderRow("o1", "u1", null, "docs");
    expect(f.type).toBe("folder");
    expect(f.status).toBe("ready");

    const kids = await svc.listChildren("o1", null);
    expect(kids.map((k) => k.id)).toContain(f.id);
  });

  // ── sumOrgReadySize 只统计 ready 文件 ───────────────────────────────────
  it("sumOrgReadySize 只统计 ready 文件（uploading 不计）", async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest
        .fn()
        .mockResolvedValueOnce({ total: "0" }) // uploading 时
        .mockResolvedValueOnce({ total: "100" }), // markReady 后
    };
    const repo = makeNodeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    });
    const svc = new CloudNodeService(repo, makeGrantSvc());

    expect(await svc.sumOrgReadySize("o1")).toBe(0);
    expect(await svc.sumOrgReadySize("o1")).toBe(100);
  });

  // ── sumOrgReadySize 不计 folder ──────────────────────────────────────────
  it("sumOrgReadySize 返回 Number（处理 bigint string）", async () => {
    // Postgres 返回 bigint 列为 string，Number() 应能正确转换
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ total: "999999999999" }),
    };
    const repo = makeNodeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    });
    const svc = new CloudNodeService(repo, makeGrantSvc());
    const result = await svc.sumOrgReadySize("o2");
    expect(result).toBe(999999999999);
    expect(typeof result).toBe("number");
  });

  // ── listAncestors ────────────────────────────────────────────────────────
  it("listAncestors 沿链向上（不含自身）", async () => {
    const root = makeNode({ id: "root-1", parentId: null, name: "root" });
    const child = makeNode({
      id: "child-1",
      parentId: "root-1",
      name: "child",
    });
    const grandchild = makeNode({
      id: "gc-1",
      parentId: "child-1",
      name: "gc",
    });

    const findOne = jest
      .fn()
      .mockImplementation(({ where: { id } }: { where: { id: string } }) => {
        if (id === "child-1") return Promise.resolve(child);
        if (id === "root-1") return Promise.resolve(root);
        return Promise.resolve(null);
      });
    const repo = makeNodeRepo({ findOne });
    const svc = new CloudNodeService(repo, makeGrantSvc());

    const ancestors = await svc.listAncestors(grandchild);
    const ids = ancestors.map((a) => a.id);
    expect(ids).toContain("child-1");
    expect(ids).toContain("root-1");
    expect(ids).not.toContain("gc-1");
    expect(ancestors.length).toBe(2);
  });

  // ── listAncestors 环路保护（C-1）────────────────────────────────────────
  it("listAncestors 对 parentId 自引用不死循环，能正常返回", async () => {
    // 坏数据：节点 A 的 parentId 指向自身
    const nodeA = makeNode({
      id: "self-loop",
      parentId: "self-loop",
      name: "A",
    });

    const findOne = jest
      .fn()
      .mockImplementation(({ where: { id } }: { where: { id: string } }) => {
        if (id === "self-loop") return Promise.resolve(nodeA);
        return Promise.resolve(null);
      });
    const repo = makeNodeRepo({ findOne });
    const svc = new CloudNodeService(repo, makeGrantSvc());

    // 不应无限挂起；jest 默认 5 s 超时即可覆盖
    const result = await svc.listAncestors(nodeA);
    // 自引用：先访问 "self-loop" → 推入 visited → 下次 break → 仅含 nodeA 自身一个结果
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("self-loop");
  });

  it("listAncestors 对两节点成环（A→B→A）不死循环", async () => {
    const nodeA = makeNode({ id: "cycleA", parentId: "cycleB", name: "A" });
    const nodeB = makeNode({ id: "cycleB", parentId: "cycleA", name: "B" });

    const findOne = jest
      .fn()
      .mockImplementation(({ where: { id } }: { where: { id: string } }) => {
        if (id === "cycleA") return Promise.resolve(nodeA);
        if (id === "cycleB") return Promise.resolve(nodeB);
        return Promise.resolve(null);
      });
    const repo = makeNodeRepo({ findOne });
    const svc = new CloudNodeService(repo, makeGrantSvc());

    // 从 nodeA 出发：cur=cycleB → 推 nodeB → cur=cycleA → cycleA 在 visited → break
    const result = await svc.listAncestors(nodeA);
    expect(result.length).toBe(2);
    expect(result.map((n) => n.id)).toEqual(["cycleB", "cycleA"]);
  });

  // ── nameExists ────────────────────────────────────────────────────────────
  it("nameExists 同级同名返回 true，不存在时返回 false", async () => {
    const countMock = jest
      .fn()
      .mockResolvedValueOnce(1) // 同名存在
      .mockResolvedValueOnce(0); // 不存在
    const repo = makeNodeRepo({ count: countMock });
    const svc = new CloudNodeService(repo, makeGrantSvc());

    expect(await svc.nameExists("o1", "parent-1", "docs")).toBe(true);
    expect(await svc.nameExists("o1", null, "docs")).toBe(false);
  });

  // ── move ────────────────────────────────────────────────────────────────
  it("move 调用 update 修改 parentId", async () => {
    const updateMock = jest.fn().mockResolvedValue({ affected: 1 });
    const repo = makeNodeRepo({ update: updateMock });
    const svc = new CloudNodeService(repo, makeGrantSvc());

    await svc.move("node-1", "new-parent-1");
    expect(updateMock).toHaveBeenCalledWith("node-1", {
      parentId: "new-parent-1",
    });
  });

  // ── move to root (M-1) ───────────────────────────────────────────────────
  it("move(id, null) 传 null 而非 undefined，能移回根目录", async () => {
    const updateMock = jest.fn().mockResolvedValue({ affected: 1 });
    const repo = makeNodeRepo({ update: updateMock });
    const svc = new CloudNodeService(repo, makeGrantSvc());

    await svc.move("node-1", null);
    // 必须传 null（让 TypeORM 将列更新为 NULL），而非 undefined（被忽略）
    expect(updateMock).toHaveBeenCalledWith("node-1", { parentId: null });
  });

  // ── delete ────────────────────────────────────────────────────────────────
  it("delete 调用 repo.delete", async () => {
    const deleteMock = jest.fn().mockResolvedValue({ affected: 1 });
    const repo = makeNodeRepo({ delete: deleteMock });
    const svc = new CloudNodeService(repo, makeGrantSvc());

    await svc.delete("node-1");
    expect(deleteMock).toHaveBeenCalledWith("node-1");
  });

  // ── rename ────────────────────────────────────────────────────────────────
  it("rename 调用 update 修改 name", async () => {
    const updateMock = jest.fn().mockResolvedValue({ affected: 1 });
    const repo = makeNodeRepo({ update: updateMock });
    const svc = new CloudNodeService(repo, makeGrantSvc());

    await svc.rename("node-1", "newname");
    expect(updateMock).toHaveBeenCalledWith("node-1", { name: "newname" });
  });

  // ── createUploadingRow 生成 assetKey ─────────────────────────────────────
  it("createUploadingRow 生成 assetKey = drive/<orgId>/<id>", async () => {
    const savedId = "node-snowflake-99";
    const savedNode = makeNode({
      id: savedId,
      type: "file",
      status: "uploading",
      orgId: "org99",
      assetKey: null,
    });
    const finalNode = { ...savedNode, assetKey: `drive/org99/${savedId}` };

    const saveMock = jest.fn().mockResolvedValue(savedNode);
    const updateMock = jest.fn().mockResolvedValue({ affected: 1 });
    const findOneMock = jest.fn().mockResolvedValue(finalNode);
    const repo = makeNodeRepo({
      create: jest.fn().mockReturnValue(savedNode),
      save: saveMock,
      update: updateMock,
      findOne: findOneMock,
    });
    const svc = new CloudNodeService(repo, makeGrantSvc());

    const node = await svc.createUploadingRow(
      "org99",
      "u1",
      null,
      "file.pdf",
      "application/pdf",
    );
    expect(node.id).toBe(savedId);
    expect(node.assetKey).toBe(`drive/org99/${savedId}`);
    expect(node.status).toBe("uploading");
    expect(node.type).toBe("file");
    // 验证 update 被以正确参数调用
    expect(updateMock).toHaveBeenCalledWith(savedId, {
      assetKey: `drive/org99/${savedId}`,
    });
  });

  // ── listStaleUploading ────────────────────────────────────────────────────
  it("listStaleUploading 调用 find 带 status=uploading + LessThan", async () => {
    const staleNode = makeNode({ status: "uploading" });
    const findMock = jest.fn().mockResolvedValue([staleNode]);
    const repo = makeNodeRepo({ find: findMock });
    const svc = new CloudNodeService(repo, makeGrantSvc());

    const result = await svc.listStaleUploading(Date.now() + 60_000);
    expect(result).toHaveLength(1);
    expect(findMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "uploading" }),
      }),
    );
  });
});

// ─────────────────────────── CloudNodeGrantService ─────────────────────────

describe("CloudNodeGrantService", () => {
  // ── replaceForNode ────────────────────────────────────────────────────────
  it("replaceForNode 先 delete 再 save", async () => {
    const deleteMock = jest.fn().mockResolvedValue({ affected: 1 });
    const saveMock = jest.fn().mockResolvedValue([]);
    const createMock = jest
      .fn()
      .mockImplementation((data: Partial<CloudNodeGrant>) => ({ ...data }));
    const repo = makeGrantRepo({
      delete: deleteMock,
      save: saveMock,
      create: createMock,
    });
    const svc = new CloudNodeGrantService(repo);

    await svc.replaceForNode("node-1", [
      { granteeType: "user", granteeId: "u2", permission: "editor" },
    ]);

    expect(deleteMock).toHaveBeenCalledWith({ nodeId: "node-1" });
    expect(saveMock).toHaveBeenCalledTimes(1);
    const savedArg = saveMock.mock.calls[0][0] as Array<
      Partial<CloudNodeGrant>
    >;
    expect(savedArg[0].permission).toBe("editor");
  });

  // ── listForNodes 批量查询 ─────────────────────────────────────────────────
  it("listForNodes 批量查询传 In 条件", async () => {
    const grants = [makeGrant({ nodeId: "n1" }), makeGrant({ nodeId: "n2" })];
    const findMock = jest.fn().mockResolvedValue(grants);
    const repo = makeGrantRepo({ find: findMock });
    const svc = new CloudNodeGrantService(repo);

    const result = await svc.listForNodes(["n1", "n2"]);
    expect(result).toHaveLength(2);
    expect(findMock).toHaveBeenCalled();
  });

  // ── listForNodes 空列表 ───────────────────────────────────────────────────
  it("listForNodes 空 nodeIds 直接返回 []（不查 DB）", async () => {
    const findMock = jest.fn();
    const repo = makeGrantRepo({ find: findMock });
    const svc = new CloudNodeGrantService(repo);

    const result = await svc.listForNodes([]);
    expect(result).toEqual([]);
    expect(findMock).not.toHaveBeenCalled();
  });

  // ── deleteForNode ─────────────────────────────────────────────────────────
  it("deleteForNode 删除节点所有授权", async () => {
    const deleteMock = jest.fn().mockResolvedValue({ affected: 2 });
    const repo = makeGrantRepo({ delete: deleteMock });
    const svc = new CloudNodeGrantService(repo);

    await svc.deleteForNode("node-1");
    expect(deleteMock).toHaveBeenCalledWith({ nodeId: "node-1" });
  });
});

// ─────────────────── CloudNodeService.deleteSubtreeInTx ────────────────────

describe("CloudNodeService.deleteSubtreeInTx", () => {
  beforeEach(() => {
    _idCounter = 1;
  });

  it("删除文件夹子树：含 ready 文件 + uploading 文件 + grant，全部被删，返回 assetKeys", async () => {
    // 结构：folder → readyFile + uploadingFile，各有 1 条 grant
    const folder = makeNode({
      id: "folder-1",
      type: "folder",
      status: "ready",
      assetKey: null,
    });
    const readyFile = makeNode({
      id: "file-ready-1",
      type: "file",
      status: "ready",
      assetKey: "drive/o1/file-ready-1",
      parentId: "folder-1",
    });
    const uploadingFile = makeNode({
      id: "file-up-1",
      type: "file",
      status: "uploading",
      assetKey: "drive/o1/file-up-1",
      parentId: "folder-1",
    });

    const deleteMock = jest.fn().mockResolvedValue({ affected: 1 });
    const repo = makeNodeRepo({
      // findOne 用于 root 查找
      findOne: jest
        .fn()
        .mockImplementation(({ where: { id } }: { where: { id: string } }) => {
          if (id === "folder-1") return Promise.resolve(folder);
          return Promise.resolve(null);
        }),
      // find 用于 listAllChildren（按 parentId 查，不带 status 过滤）
      find: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { parentId?: string; status?: string } }) => {
            if (where.parentId === "folder-1") {
              return Promise.resolve([readyFile, uploadingFile]);
            }
            // file 节点无子节点
            return Promise.resolve([]);
          },
        ),
      delete: deleteMock,
    });

    const deleteForNodeMock = jest.fn().mockResolvedValue(undefined);
    const grantSvc = makeGrantSvc({ deleteForNode: deleteForNodeMock });
    const svc = new CloudNodeService(repo, grantSvc);

    const assetKeys = await svc.deleteSubtreeInTx("folder-1");

    // 三个节点全部被删
    expect(deleteMock).toHaveBeenCalledTimes(3);
    expect(deleteMock).toHaveBeenCalledWith("folder-1");
    expect(deleteMock).toHaveBeenCalledWith("file-ready-1");
    expect(deleteMock).toHaveBeenCalledWith("file-up-1");

    // grant 对三个节点都清理
    expect(deleteForNodeMock).toHaveBeenCalledTimes(3);
    expect(deleteForNodeMock).toHaveBeenCalledWith("folder-1");
    expect(deleteForNodeMock).toHaveBeenCalledWith("file-ready-1");
    expect(deleteForNodeMock).toHaveBeenCalledWith("file-up-1");

    // 返回两个文件的 assetKey（uploading 也包含）
    expect(assetKeys).toHaveLength(2);
    expect(assetKeys).toContain("drive/o1/file-ready-1");
    expect(assetKeys).toContain("drive/o1/file-up-1");
  });

  it("rootId 不存在 → 返回空数组，不调任何 delete", async () => {
    const deleteMock = jest.fn();
    const deleteForNodeMock = jest.fn();
    const repo = makeNodeRepo({
      findOne: jest.fn().mockResolvedValue(null),
      delete: deleteMock,
    });
    const grantSvc = makeGrantSvc({ deleteForNode: deleteForNodeMock });
    const svc = new CloudNodeService(repo, grantSvc);

    const result = await svc.deleteSubtreeInTx("nonexistent");

    expect(result).toEqual([]);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(deleteForNodeMock).not.toHaveBeenCalled();
  });

  it("脏数据成环（子节点 parentId 指回祖先）→ BFS 正常终止，仅删已访问节点", async () => {
    // 结构：folderA → folderB，但 folderB 的子节点 folderC 的 parentId 指回 folderA（成环）
    const folderA = makeNode({ id: "cycleA", type: "folder", assetKey: null });
    const folderB = makeNode({
      id: "cycleB",
      type: "folder",
      assetKey: null,
      parentId: "cycleA",
    });
    const folderC = makeNode({
      id: "cycleC",
      type: "folder",
      assetKey: null,
      parentId: "cycleB",
    });

    const deleteMock = jest.fn().mockResolvedValue({ affected: 1 });
    const repo = makeNodeRepo({
      findOne: jest
        .fn()
        .mockImplementation(({ where: { id } }: { where: { id: string } }) => {
          if (id === "cycleA") return Promise.resolve(folderA);
          return Promise.resolve(null);
        }),
      // listAllChildren：folderA→[folderB], folderB→[folderC], folderC→[folderA]（环）
      find: jest
        .fn()
        .mockImplementation(({ where }: { where: { parentId?: string } }) => {
          if (where.parentId === "cycleA") return Promise.resolve([folderB]);
          if (where.parentId === "cycleB") return Promise.resolve([folderC]);
          if (where.parentId === "cycleC") return Promise.resolve([folderA]); // 脏数据：C 指回 A
          return Promise.resolve([]);
        }),
      delete: deleteMock,
    });

    const deleteForNodeMock = jest.fn().mockResolvedValue(undefined);
    const grantSvc = makeGrantSvc({ deleteForNode: deleteForNodeMock });
    const svc = new CloudNodeService(repo, grantSvc);

    // 不应死循环，应正常返回
    const assetKeys = await svc.deleteSubtreeInTx("cycleA");

    // 三个节点各被删一次（visited 防止 folderA 重复入队）
    expect(deleteMock).toHaveBeenCalledTimes(3);
    expect(deleteMock).toHaveBeenCalledWith("cycleA");
    expect(deleteMock).toHaveBeenCalledWith("cycleB");
    expect(deleteMock).toHaveBeenCalledWith("cycleC");
    // 全 folder 无 assetKey，返回空数组
    expect(assetKeys).toEqual([]);
  });
});
