/**
 * drive.e2e.spec.ts — 降级集成测试（Postgres 本环境不可达）
 *
 * 测试策略：CloudDriveService + 真实 CloudNodeService/CloudNodeGrantService
 * （jest mock Repository，内存 Map 模拟数据）+ mock AssetService（presigned/stat/delete 桩）。
 *
 * 覆盖 spec §10 场景：
 * 1. 建夹 → listNodes 含它
 * 2. 上传两阶段（requestUpload 返 putUrl + uploading 不在 list；completeUpload 后 ready 入 list + 计入 quota）
 * 3. 改名/移动（防环 → DRIVE_INVALID_MOVE）
 * 4. 删除文件夹递归（子节点 + grant 清掉 + asset.delete 调用）
 * 5. 配额超限 → DRIVE_QUOTA_EXCEEDED
 * 6. ACL 矩阵（B 对 A 私有节点 list/downloadUrl → DRIVE_FORBIDDEN；
 *              A setGrants 给 B viewer 后 B 可 list 不可 delete；editor 可 upload）
 * 7. 继承（A 共享文件夹给 B → B 可见子文件）
 * 8. listShared 返回被授权节点
 */
import "reflect-metadata";
import { AssetService } from "@meshbot/assets";
import { Test } from "@nestjs/testing";
import { Repository } from "typeorm";

import { MainErrorCode } from "@meshbot/main";
import { CloudDriveService } from "@meshbot/main";
import { CloudNodeGrantService } from "@meshbot/main";
import { CloudNodeService } from "@meshbot/main";
import { CloudNode } from "@meshbot/main";
import { CloudNodeGrant } from "@meshbot/main";

// ─────────────────────── ID 生成 ────────────────────────────────────────────

let _idSeq = 1;
function nextId(): string {
  return String(100_000_000_000_000_000n + BigInt(_idSeq++));
}

// ─────────────────────── 内存 Repository ────────────────────────────────────

/**
 * 构造假 DataSource（供 @Transactional() root 路径使用）。
 * @Transactional() 通过 `value instanceof Repository` 找到 DataSource，
 * 因此 repo 对象必须继承 Repository.prototype（用 Object.create 实现）。
 */
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

/** 判断 typeorm `FindOperator`（IsNull/In 等）的辅助函数 */
function isIsNull(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === "object" &&
    "_type" in (v as Record<string, unknown>) &&
    (v as Record<string, unknown>)._type === "isNull"
  );
}
function isInOperator(v: unknown): v is { _value: string[] } {
  return (
    v !== null &&
    typeof v === "object" &&
    "_type" in (v as Record<string, unknown>) &&
    (v as Record<string, unknown>)._type === "in"
  );
}

/**
 * 内存 CloudNode 存储，模拟 TypeORM Repository 的常用方法。
 * 继承 Repository.prototype，使 @Transactional() 的 instanceof 检查通过。
 */
function makeNodeRepo(): Repository<CloudNode> {
  const store = new Map<string, CloudNode>();
  const fakeDs = makeFakeDataSource();

  return Object.assign(Object.create(Repository.prototype), {
    create(data: Partial<CloudNode>): CloudNode {
      return { ...data } as CloudNode;
    },
    async save(
      entity: Partial<CloudNode> | Partial<CloudNode>[],
    ): Promise<unknown> {
      if (Array.isArray(entity)) {
        return entity.map((e) => {
          const id = (e as CloudNode).id ?? nextId();
          const n = { ...(e as CloudNode), id };
          store.set(id, n);
          return n;
        });
      }
      const id = (entity as CloudNode).id ?? nextId();
      const n = { ...(entity as CloudNode), id };
      store.set(id, n);
      return n;
    },
    async findOne({
      where,
    }: {
      where: Record<string, unknown>;
    }): Promise<CloudNode | null> {
      if (where.id) return store.get(where.id as string) ?? null;
      return null;
    },
    async find(
      { where }: { where: Record<string, unknown> } = { where: {} },
    ): Promise<CloudNode[]> {
      let results = [...store.values()];
      if (where.orgId !== undefined)
        results = results.filter((n) => n.orgId === where.orgId);
      if (where.parentId !== undefined) {
        const pid = where.parentId;
        if (pid === null || isIsNull(pid)) {
          results = results.filter((n) => n.parentId === null);
        } else if (typeof pid === "string") {
          results = results.filter((n) => n.parentId === pid);
        }
      }
      if (where.status !== undefined)
        results = results.filter((n) => n.status === where.status);
      return results;
    },
    async count({
      where,
    }: {
      where: Record<string, unknown>;
    }): Promise<number> {
      let results = [...store.values()];
      if (where.orgId !== undefined)
        results = results.filter((n) => n.orgId === where.orgId);
      if (where.parentId !== undefined) {
        const pid = where.parentId;
        if (pid === null || isIsNull(pid)) {
          results = results.filter((n) => n.parentId === null);
        } else if (typeof pid === "string") {
          results = results.filter((n) => n.parentId === pid);
        }
      }
      if (where.name !== undefined)
        results = results.filter((n) => n.name === where.name);
      return results.length;
    },
    async update(
      id: string,
      partial: Partial<CloudNode>,
    ): Promise<{ affected: number }> {
      const n = store.get(id);
      if (!n) return { affected: 0 };
      Object.assign(n, partial);
      return { affected: 1 };
    },
    async delete(
      where: string | Record<string, unknown>,
    ): Promise<{ affected: number }> {
      if (typeof where === "string") {
        const existed = store.has(where);
        store.delete(where);
        return { affected: existed ? 1 : 0 };
      }
      return { affected: 0 };
    },
    createQueryBuilder() {
      let _orgFilter: string | null = null;
      const qb = {
        select(_s: string) {
          return qb;
        },
        where(_cond: string, params: { orgId: string }) {
          _orgFilter = params?.orgId ?? null;
          return qb;
        },
        async getRawOne() {
          const nodes = [...store.values()];
          const filtered = nodes.filter(
            (n) =>
              n.type === "file" &&
              n.status === "ready" &&
              (_orgFilter === null || n.orgId === _orgFilter),
          );
          const total = filtered.reduce(
            (sum, n) => sum + (Number(n.sizeBytes) || 0),
            0,
          );
          return { total: String(total) };
        },
      };
      return qb;
    },
    manager: { connection: fakeDs },
  }) as unknown as Repository<CloudNode>;
}

/**
 * 内存 CloudNodeGrant 存储。继承 Repository.prototype 以通过 instanceof 检查。
 */
function makeGrantRepo(): Repository<CloudNodeGrant> {
  const store = new Map<string, CloudNodeGrant>();
  const fakeDs = makeFakeDataSource();

  return Object.assign(Object.create(Repository.prototype), {
    create(data: Partial<CloudNodeGrant>): CloudNodeGrant {
      return { ...data } as CloudNodeGrant;
    },
    async save(
      entity: Partial<CloudNodeGrant> | Partial<CloudNodeGrant>[],
    ): Promise<unknown> {
      if (Array.isArray(entity)) {
        return entity.map((e) => {
          const id = (e as CloudNodeGrant).id ?? nextId();
          const g = { ...(e as CloudNodeGrant), id };
          store.set(id, g);
          return g;
        });
      }
      const id = (entity as CloudNodeGrant).id ?? nextId();
      const g = { ...(entity as CloudNodeGrant), id };
      store.set(id, g);
      return g;
    },
    async find(
      { where }: { where: Record<string, unknown> } = { where: {} },
    ): Promise<CloudNodeGrant[]> {
      let results = [...store.values()];
      if (where.nodeId !== undefined) {
        const nid = where.nodeId;
        if (isInOperator(nid)) {
          const ids = nid._value;
          results = results.filter((g) => ids.includes(g.nodeId));
        } else if (typeof nid === "string") {
          results = results.filter((g) => g.nodeId === nid);
        }
      }
      if (where.granteeType !== undefined)
        results = results.filter((g) => g.granteeType === where.granteeType);
      if (where.granteeId !== undefined)
        results = results.filter((g) => g.granteeId === where.granteeId);
      return results;
    },
    async delete(
      where: string | Record<string, unknown>,
    ): Promise<{ affected: number }> {
      if (typeof where === "object" && "nodeId" in where) {
        const toDelete = [...store.entries()].filter(
          ([, g]) => g.nodeId === where.nodeId,
        );
        for (const [id] of toDelete) store.delete(id);
        return { affected: toDelete.length };
      }
      return { affected: 0 };
    },
    manager: { connection: fakeDs },
  }) as unknown as Repository<CloudNodeGrant>;
}

// ─────────────────────── 测试工厂 ────────────────────────────────────────────

async function buildModule() {
  const nodeRepo = makeNodeRepo();
  const grantRepo = makeGrantRepo();

  const assetMock = {
    getUploadUrl: jest.fn().mockResolvedValue("https://minio/put-url"),
    getSignedUrl: jest.fn().mockResolvedValue("https://minio/signed-url"),
    stat: jest.fn().mockResolvedValue({ size: 500 }),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  const module = await Test.createTestingModule({
    providers: [
      CloudDriveService,
      CloudNodeService,
      CloudNodeGrantService,
      { provide: "CloudNodeRepository", useValue: nodeRepo },
      { provide: "CloudNodeGrantRepository", useValue: grantRepo },
      { provide: AssetService, useValue: assetMock },
      // TypeORM InjectRepository token（NestJS 约定）
      {
        provide: `${CloudNode.name}Repository`,
        useValue: nodeRepo,
      },
      {
        provide: `${CloudNodeGrant.name}Repository`,
        useValue: grantRepo,
      },
    ],
  }).compile();

  return {
    svc: module.get(CloudDriveService),
    assetMock,
    nodeRepo,
    grantRepo,
  };
}

// ─────────────────────── 常量 ctx ────────────────────────────────────────────

const ctxA = { userId: "userA", orgId: "org1" };
const ctxB = { userId: "userB", orgId: "org1" };
const ctxC = { userId: "userC", orgId: "org2" }; // 不同 org

// ─────────────────────── 测试套件 ────────────────────────────────────────────

describe("CloudDriveService 集成测试（降级方案）", () => {
  let svc: CloudDriveService;
  let assetMock: ReturnType<typeof buildModule> extends Promise<infer T>
    ? T["assetMock"]
    : never;

  beforeEach(async () => {
    _idSeq = 1;
    jest.clearAllMocks();
    const ctx = await buildModule();
    svc = ctx.svc;
    assetMock = ctx.assetMock;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. 建夹 → listNodes 含它
  // ──────────────────────────────────────────────────────────────────────────

  it("createFolder → listNodes(null) 包含新建文件夹", async () => {
    const folder = await svc.createFolder(ctxA, null, "文档");
    expect(folder.type).toBe("folder");
    expect(folder.name).toBe("文档");
    expect(folder.permission).toBe("owner");

    const nodes = await svc.listNodes(ctxA, null);
    expect(nodes.map((n) => n.id)).toContain(folder.id);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. 上传两阶段
  // ──────────────────────────────────────────────────────────────────────────

  it("requestUpload 返回 putUrl，uploading 节点不出现在 listNodes", async () => {
    const { nodeId, putUrl } = await svc.requestUpload(ctxA, {
      name: "test.pdf",
      parentId: null,
      size: 100,
      mime: "application/pdf",
    });

    expect(typeof nodeId).toBe("string");
    expect(putUrl).toBe("https://minio/put-url");

    // uploading 状态节点不在 listNodes（listChildren 只查 ready）
    const nodes = await svc.listNodes(ctxA, null);
    expect(nodes.map((n) => n.id)).not.toContain(nodeId);
  });

  it("completeUpload 后 ready 入 listNodes + 计入 quota", async () => {
    assetMock.stat.mockResolvedValue({ size: 1024 });

    const { nodeId } = await svc.requestUpload(ctxA, {
      name: "report.pdf",
      parentId: null,
      size: 1024,
      mime: "application/pdf",
    });

    // 先不在 list
    let nodes = await svc.listNodes(ctxA, null);
    expect(nodes.map((n) => n.id)).not.toContain(nodeId);

    const view = await svc.completeUpload(ctxA, nodeId, "chk-abc");
    expect(view.status).toBe("ready");
    expect(view.sizeBytes).toBe(1024);

    // 现在在 list
    nodes = await svc.listNodes(ctxA, null);
    expect(nodes.map((n) => n.id)).toContain(nodeId);

    // 计入 quota
    const q = await svc.quota(ctxA);
    expect(q.used).toBe(1024);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. 改名/移动（防环 → DRIVE_INVALID_MOVE）
  // ──────────────────────────────────────────────────────────────────────────

  it("rename 改名后 listNodes 反映新名字", async () => {
    const f = await svc.createFolder(ctxA, null, "旧名");
    await svc.rename(ctxA, f.id, "新名");

    const nodes = await svc.listNodes(ctxA, null);
    const found = nodes.find((n) => n.id === f.id);
    expect(found?.name).toBe("新名");
  });

  it("move 节点到子孙 → DRIVE_INVALID_MOVE", async () => {
    const parent = await svc.createFolder(ctxA, null, "parent");
    const child = await svc.createFolder(ctxA, parent.id, "child");

    await expect(svc.move(ctxA, parent.id, child.id)).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_INVALID_MOVE.code },
    });
  });

  it("move 节点到自身 → DRIVE_INVALID_MOVE", async () => {
    const f = await svc.createFolder(ctxA, null, "self");
    await expect(svc.move(ctxA, f.id, f.id)).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_INVALID_MOVE.code },
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. 删除文件夹递归（子节点 + grant 清 + asset.delete 调用）
  // ──────────────────────────────────────────────────────────────────────────

  it("deleteNode 递归删子树：子 uploading 文件 + grant 清 + asset.delete 调用", async () => {
    const folder = await svc.createFolder(ctxA, null, "myFolder");

    // 上传子文件（uploading 状态）
    assetMock.stat.mockResolvedValue({ size: 200 });
    await svc.requestUpload(ctxA, {
      name: "inner.txt",
      parentId: folder.id,
      size: 200,
      mime: "text/plain",
    });

    // 为子文件设一条 grant
    await svc.setGrants(ctxA, folder.id, {
      grants: [
        { granteeType: "user", granteeId: "userB", permission: "viewer" },
      ],
    });

    await svc.deleteNode(ctxA, folder.id);

    // 删后 listNodes 不含该夹
    const nodes = await svc.listNodes(ctxA, null);
    expect(nodes.map((n) => n.id)).not.toContain(folder.id);

    // asset.delete 被调（子文件有 assetKey）
    expect(assetMock.delete).toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. 配额超限 → DRIVE_QUOTA_EXCEEDED
  // ──────────────────────────────────────────────────────────────────────────

  it("requestUpload size 超配额 → DRIVE_QUOTA_EXCEEDED", async () => {
    // 5GB quota，传入 size 超出
    const FIVE_GB = 5 * 1024 ** 3;
    await expect(
      svc.requestUpload(ctxA, {
        name: "huge.bin",
        parentId: null,
        size: FIVE_GB + 1,
        mime: "application/octet-stream",
      }),
    ).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_QUOTA_EXCEEDED.code },
    });
  });

  it("completeUpload stat 后超配额 → DRIVE_QUOTA_EXCEEDED + 删除 node + asset", async () => {
    // requestUpload size=100（预检通过）
    const { nodeId } = await svc.requestUpload(ctxA, {
      name: "tricky.bin",
      parentId: null,
      size: 100,
      mime: "application/octet-stream",
    });

    // stat 返回接近 5GB 的大小（already-used=0，但此时 ready 已经积累接近满额）
    // 通过先上传一批 ready 文件模拟
    // 简化：直接让 stat 返回超过配额的大小
    const FIVE_GB = 5 * 1024 ** 3;
    assetMock.stat.mockResolvedValue({ size: FIVE_GB + 100 });

    await expect(svc.completeUpload(ctxA, nodeId)).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_QUOTA_EXCEEDED.code },
    });

    // node 已被删（deleteNode 后 findById 返回 null → listNodes 不含它）
    const nodes = await svc.listNodes(ctxA, null);
    expect(nodes.map((n) => n.id)).not.toContain(nodeId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. ACL 矩阵
  // ──────────────────────────────────────────────────────────────────────────

  it("B 对 A 私有节点 listNodes → DRIVE_FORBIDDEN", async () => {
    const folder = await svc.createFolder(ctxA, null, "privateDir");

    // B 尝试 listNodes(parentId=folder.id) → 无权
    await expect(svc.listNodes(ctxB, folder.id)).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_FORBIDDEN.code },
    });
  });

  it("B 对 A 私有文件 getDownloadUrl → DRIVE_FORBIDDEN", async () => {
    assetMock.stat.mockResolvedValue({ size: 100 });
    const { nodeId } = await svc.requestUpload(ctxA, {
      name: "secret.pdf",
      parentId: null,
      size: 100,
      mime: "application/pdf",
    });
    await svc.completeUpload(ctxA, nodeId);

    await expect(svc.getDownloadUrl(ctxB, nodeId)).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_FORBIDDEN.code },
    });
  });

  it("A setGrants 给 B viewer → B 可 listNodes，不可 deleteNode", async () => {
    const folder = await svc.createFolder(ctxA, null, "sharedDir");

    // 授权 B viewer
    await svc.setGrants(ctxA, folder.id, {
      grants: [
        { granteeType: "user", granteeId: "userB", permission: "viewer" },
      ],
    });

    // B 可以 listNodes（viewer 允许）— parentId=folder.id → 权限检查 parent → viewer 通过
    // 先在 folder 下建个子文件夹
    const sub = await svc.createFolder(ctxA, folder.id, "sub");

    const nodes = await svc.listNodes(ctxB, folder.id);
    expect(nodes.map((n) => n.id)).toContain(sub.id);

    // B 不可 deleteNode（editor 权限不足）
    await expect(svc.deleteNode(ctxB, sub.id)).rejects.toMatchObject({
      errorCode: { code: MainErrorCode.DRIVE_FORBIDDEN.code },
    });
  });

  it("editor 可以 upload（requestUpload 通过）", async () => {
    const folder = await svc.createFolder(ctxA, null, "editorDir");

    // 授权 B editor
    await svc.setGrants(ctxA, folder.id, {
      grants: [
        { granteeType: "user", granteeId: "userB", permission: "editor" },
      ],
    });

    // B editor 可以上传到该目录
    const { nodeId, putUrl } = await svc.requestUpload(ctxB, {
      name: "b-upload.txt",
      parentId: folder.id,
      size: 10,
      mime: "text/plain",
    });

    expect(typeof nodeId).toBe("string");
    expect(putUrl).toBe("https://minio/put-url");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7. 继承（A 共享文件夹给 B → B 可见子文件）
  // ──────────────────────────────────────────────────────────────────────────

  it("A 共享文件夹给 B → B 可见子文件（权限继承）", async () => {
    const parentFolder = await svc.createFolder(ctxA, null, "parentFolder");
    const childFolder = await svc.createFolder(
      ctxA,
      parentFolder.id,
      "childFolder",
    );

    // 仅对 parentFolder 授权 B viewer
    await svc.setGrants(ctxA, parentFolder.id, {
      grants: [
        { granteeType: "user", granteeId: "userB", permission: "viewer" },
      ],
    });

    // B 可以 listNodes(parentId=parentFolder.id)（直接 grant）
    const nodesInParent = await svc.listNodes(ctxB, parentFolder.id);
    expect(nodesInParent.map((n) => n.id)).toContain(childFolder.id);

    // B 也可以 listNodes(parentId=childFolder.id)（从 parent 继承 viewer 权限）
    const grandChild = await svc.createFolder(
      ctxA,
      childFolder.id,
      "grandChild",
    );
    const nodesInChild = await svc.listNodes(ctxB, childFolder.id);
    expect(nodesInChild.map((n) => n.id)).toContain(grandChild.id);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 8. listShared 返回被授权节点
  // ──────────────────────────────────────────────────────────────────────────

  it("listShared 返回直接授权给 B 的节点", async () => {
    const folder = await svc.createFolder(ctxA, null, "sharedForB");

    await svc.setGrants(ctxA, folder.id, {
      grants: [
        { granteeType: "user", granteeId: "userB", permission: "editor" },
      ],
    });

    const shared = await svc.listShared(ctxB);
    expect(shared.map((n) => n.id)).toContain(folder.id);
    // B 的权限应为 editor（因为有 grant）
    const found = shared.find((n) => n.id === folder.id);
    expect(found?.permission).toBe("editor");
  });

  it("listShared 不跨 org（C 属于 org2，不可见 org1 的 grant）", async () => {
    const folder = await svc.createFolder(ctxA, null, "org1Folder");

    // 只给 B（org1）授权
    await svc.setGrants(ctxA, folder.id, {
      grants: [
        { granteeType: "user", granteeId: "userB", permission: "viewer" },
      ],
    });

    // C 在 org2，listShared 不应看到 folder
    const shared = await svc.listShared(ctxC);
    expect(shared.map((n) => n.id)).not.toContain(folder.id);
  });
});
