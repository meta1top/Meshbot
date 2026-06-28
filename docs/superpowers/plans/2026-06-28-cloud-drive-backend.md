# 企业网盘后端（SP-A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** server-main 实现企业级网盘后端：cloud_node/cloud_node_grant 两表 + Google Drive 式 ACL（viewer/editor + 继承）+ org 配额 + presigned 直传/直下 CRUD，server-agent 纯 JSON 网关代理。

**Architecture:** 文件字节走 Minio presigned 直传/直下（后端不中转），元数据 + 鉴权 + 签 URL 在 server-main Postgres。ACL 沿 parent 链收集 grant 取最高权限。server-agent 用账号 cloudToken（已含 orgId，SP-0 就绪）转发 server-main，是纯 JSON 网关。

**Tech Stack:** NestJS / TypeORM / Postgres（server-main）/ Minio（libs/assets）/ Zod（libs/types-main）/ CloudClient（server-agent）。

## Global Constraints

- **依赖 SP-0（已合并 main）**：`JwtMainPayload` 含 `{userId, email, orgId}`；drive 接口 org 取自 `@CurrentUser().orgId`，不再 resolveOrgId。
- **错误码**：`MainErrorCode` 现到 2012，新增 DRIVE_* 用 **2013-2018**（范围 2000-2999，check:error-code 围栏）：`DRIVE_NODE_NOT_FOUND`/`DRIVE_FORBIDDEN`(403)/`DRIVE_QUOTA_EXCEEDED`/`DRIVE_INVALID_MOVE`/`DRIVE_NAME_CONFLICT`/`DRIVE_NOT_READY`。
- **Entity**：继承 `SnowflakeBaseEntity`（check:pk）；雪花 id varchar(20)；逻辑外键（无 `@ManyToOne`/`@JoinColumn`）；列 snake_case（SnakeNamingStrategy 自动）。
- **check:repo 单一归属**：`CloudNode` 归 `CloudNodeService`、`CloudNodeGrant` 归 `CloudNodeGrantService`（各唯一 `@InjectRepository`）；编排 `CloudDriveService` 不直接注入 Repository。
- **`@Transactional` 命名**：跨表写（删文件夹递归 + Minio）用 `@Transactional()`，私有方法命名 `*InTx`/`persist*`（check:naming）；单表写不挂。
- **DDL**：纯 SQL 文件 `apps/server-main/migrations/<YYYYMMDDHHmm>-cloud-drive.sql`，幂等（`IF NOT EXISTS`）、snake_case、逻辑外键、DBA 手动执行（服务不自动建表）。
- **types-main 禁依赖 NestJS**：Zod schema 在 `libs/types-main`；`createZodDto` 的 DTO class 在 `libs/main/src/dto`。
- **asset_key 格式**：`drive/<org_id>/<node_id>`；bucket 复用现有 AssetsModule 配置（不新建 bucket）。
- **presigned 直传前提**：Minio 公网可达 + CORS（运维约束，已与用户确认可配）。
- **Postgres e2e**：本环境 Postgres 可能不可达——e2e 跑不起来时降级为等价单测（in-memory better-sqlite3 like `schedule-executor.service.spec.ts`，或 mock service 层）。报告写清。
- 公开方法中文 JSDoc；不在 `if` 前一行放注释；中文提交。

---

## File Structure

- `libs/assets/src/asset.service.ts` + `providers/minio-asset.service.ts` + `asset.types.ts` — 加 `getUploadUrl` + `stat`（Task 1）。
- `libs/main/src/entities/cloud-node.entity.ts` / `cloud-node-grant.entity.ts` — 数据模型（Task 2）。
- `apps/server-main/migrations/<ts>-cloud-drive.sql` — DDL（Task 2）。
- `libs/main/src/errors/main.error-codes.ts` — DRIVE_* 错误码（Task 2）。
- `libs/main/src/services/drive-acl.ts` — `resolvePermission` 纯函数（Task 3）。
- `libs/main/src/services/cloud-node.service.ts` / `cloud-node-grant.service.ts` — 归属 CRUD（Task 4）。
- `libs/main/src/services/cloud-drive.service.ts` — 编排 + ACL + 配额（Task 5）。
- `libs/types-main/src/drive.ts` + `libs/main/src/dto/` — schema + DTO（Task 5）。
- `apps/server-main/src/rest/drive.controller.ts` + `apps/server-main/test/e2e/drive.e2e.spec.ts` — 接口 + e2e（Task 6）。
- `apps/server-agent/src/controllers/drive.controller.ts` + `services/drive-gateway.service.ts` — 网关（Task 7）。
- 模块注册：`libs/main` 的 module（TxTypeOrmModule.forFeature 注册 Entity + 导出 service）、`apps/server-main` 的 app.module、`apps/server-agent` 网关模块。

---

## Task 1: libs/assets 扩展（presigned 上传 + stat）

**Files:**
- Modify: `libs/assets/src/asset.service.ts`、`libs/assets/src/providers/minio-asset.service.ts`、`libs/assets/src/asset.types.ts`
- Test: `libs/assets/src/providers/minio-asset.service.spec.ts`（新建或追加；mock `minio`）

**Interfaces:**
- Produces: `AssetService.getUploadUrl(key: string, ttlSeconds: number): Promise<string>`（presigned PUT URL）。
- Produces: `AssetService.stat(key: string): Promise<{ size: number }>`。

- [ ] **Step 1: 确认 asset.types** — `asset.service.ts` 已 `import type { AssetStat } from "./asset.types"`。先 Read `libs/assets/src/asset.types.ts` 确认 `AssetStat` 是否已定义；若无 `size` 字段则补 `export interface AssetStat { size: number }`。

- [ ] **Step 2: 写失败测试** — `minio-asset.service.spec.ts`，mock minio client 的 `presignedPutObject` / `statObject`：

```typescript
jest.mock("minio");
import { Client } from "minio";
import { MinioAssetService } from "./minio-asset.service";

describe("MinioAssetService presigned PUT + stat", () => {
  const cfg = { endPoint: "localhost", port: 9000, useSSL: false, accessKey: "a", secretKey: "b", bucket: "test-bucket" };
  it("getUploadUrl 调 presignedPutObject 返回 URL", async () => {
    const put = jest.fn().mockResolvedValue("http://minio/put-url");
    (Client as jest.Mock).mockImplementation(() => ({ presignedPutObject: put }));
    const svc = new MinioAssetService(cfg);
    const url = await svc.getUploadUrl("drive/o1/n1", 600);
    expect(put).toHaveBeenCalledWith("test-bucket", "drive/o1/n1", 600);
    expect(url).toBe("http://minio/put-url");
  });
  it("stat 调 statObject 返回 size", async () => {
    const stat = jest.fn().mockResolvedValue({ size: 1234 });
    (Client as jest.Mock).mockImplementation(() => ({ statObject: stat }));
    const svc = new MinioAssetService(cfg);
    const res = await svc.stat("drive/o1/n1");
    expect(stat).toHaveBeenCalledWith("test-bucket", "drive/o1/n1");
    expect(res).toEqual({ size: 1234 });
  });
});
```

- [ ] **Step 3: 跑测试验证失败** — `pnpm test -- minio-asset.service`，Expected: FAIL（方法不存在）。

- [ ] **Step 4: 实现** — `asset.service.ts` 抽象类加：

```typescript
  /** 取临时上传（PUT）签名 URL —— 客户端直传 Minio 用。 */
  abstract getUploadUrl(key: string, ttlSeconds: number): Promise<string>;
  /** 取对象元信息（size 等）。 */
  abstract stat(key: string): Promise<AssetStat>;
```

`minio-asset.service.ts` 实现：

```typescript
  /** 取临时上传（PUT）签名 URL。 */
  async getUploadUrl(key: string, ttlSeconds: number): Promise<string> {
    return this.client.presignedPutObject(this.bucket, key, ttlSeconds);
  }

  /** 取对象元信息（size）。 */
  async stat(key: string): Promise<AssetStat> {
    const s = await this.client.statObject(this.bucket, key);
    return { size: s.size };
  }
```

（import `AssetStat`：`import type { AssetStat } from "../asset.types";`）

- [ ] **Step 5: 跑测试验证通过** — `pnpm test -- minio-asset.service`，Expected: PASS。
- [ ] **Step 6: typecheck + commit** — `pnpm turbo typecheck --filter=@meshbot/assets`；`git commit -m "feat(assets): AssetService 加 presigned 上传 URL 与 stat"`

---

## Task 2: Entity + DDL + 错误码

**Files:**
- Create: `libs/main/src/entities/cloud-node.entity.ts`、`libs/main/src/entities/cloud-node-grant.entity.ts`
- Create: `apps/server-main/migrations/<YYYYMMDDHHmm>-cloud-drive.sql`
- Modify: `libs/main/src/errors/main.error-codes.ts`、`libs/main` 的 entities barrel（`rg -l "skill-version.entity" libs/main/src` 找 index）
- Test: 无（纯数据定义；下游 task 的测试覆盖）

**Interfaces:**
- Produces: `CloudNode`（id, orgId, ownerUserId, parentId, type, name, assetKey, sizeBytes, mime, checksum, status, createdAt, updatedAt）。
- Produces: `CloudNodeGrant`（id, nodeId, granteeType, granteeId, permission, createdAt）。
- Produces: `MainErrorCode.{DRIVE_NODE_NOT_FOUND, DRIVE_FORBIDDEN, DRIVE_QUOTA_EXCEEDED, DRIVE_INVALID_MOVE, DRIVE_NAME_CONFLICT, DRIVE_NOT_READY}`。

- [ ] **Step 1: CloudNode Entity** — `cloud-node.entity.ts`（参考 `skill-version.entity.ts` 写法）：

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index, UpdateDateColumn } from "typeorm";

/** 网盘节点（文件或文件夹统一表）。parent_id 自引用成目录树；asset_key 指向 Minio。 */
@Entity("cloud_node")
@Index("idx_cloud_node_parent", ["parentId"])
@Index("idx_cloud_node_org", ["orgId"])
export class CloudNode extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 }) orgId!: string;
  @Column({ type: "varchar", length: 20 }) ownerUserId!: string;
  @Column({ type: "varchar", length: 20, nullable: true }) parentId!: string | null;
  @Column({ type: "varchar", length: 8 }) type!: "file" | "folder";
  @Column({ type: "varchar", length: 256 }) name!: string;
  @Column({ type: "varchar", length: 256, nullable: true }) assetKey!: string | null;
  @Column({ type: "bigint", default: 0 }) sizeBytes!: number;
  @Column({ type: "varchar", length: 128, nullable: true }) mime!: string | null;
  @Column({ type: "varchar", length: 64, nullable: true }) checksum!: string | null;
  @Column({ type: "varchar", length: 12, default: "ready" }) status!: "uploading" | "ready";
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" }) updatedAt!: Date;
}
```

> 注：`bigint` 在 TypeORM 默认映射为 string。本表 `sizeBytes` 用 number 列声明，读出时可能是 string——CloudNodeService 的 sum/比较处统一 `Number(...)`。实现 Task 4/5 时注意。

- [ ] **Step 2: CloudNodeGrant Entity** — `cloud-node-grant.entity.ts`：

```typescript
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 网盘 ACL 授权。无 grant = 私有（仅 owner）。同一被授权方一条（唯一），重设覆盖 permission。 */
@Entity("cloud_node_grant")
@Index("idx_cloud_grant_node", ["nodeId"])
@Index("idx_cloud_grant_unique", ["nodeId", "granteeType", "granteeId"], { unique: true })
export class CloudNodeGrant extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 }) nodeId!: string;
  @Column({ type: "varchar", length: 8 }) granteeType!: "org" | "user";
  @Column({ type: "varchar", length: 20 }) granteeId!: string;
  @Column({ type: "varchar", length: 8 }) permission!: "viewer" | "editor";
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
}
```

- [ ] **Step 3: DDL** — `apps/server-main/migrations/<YYYYMMDDHHmm>-cloud-drive.sql`（时间戳用当前 UTC `YYYYMMDDHHmm`，参考 `202606221200-skill-marketplace.sql` 格式）：

```sql
-- 企业网盘（SP-A）。DBA 手动执行；幂等；snake_case；逻辑外键；id 雪花 varchar(20)。
CREATE TABLE IF NOT EXISTS "cloud_node" (
  "id"             varchar(20)  NOT NULL,
  "org_id"         varchar(20)  NOT NULL,
  "owner_user_id"  varchar(20)  NOT NULL,
  "parent_id"      varchar(20),
  "type"           varchar(8)   NOT NULL,
  "name"           varchar(256) NOT NULL,
  "asset_key"      varchar(256),
  "size_bytes"     bigint       NOT NULL DEFAULT 0,
  "mime"           varchar(128),
  "checksum"       varchar(64),
  "status"         varchar(12)  NOT NULL DEFAULT 'ready',
  "created_at"     timestamptz  NOT NULL DEFAULT now(),
  "updated_at"     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_cloud_node" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_cloud_node_parent" ON "cloud_node" ("parent_id");
CREATE INDEX IF NOT EXISTS "idx_cloud_node_org" ON "cloud_node" ("org_id");

CREATE TABLE IF NOT EXISTS "cloud_node_grant" (
  "id"            varchar(20) NOT NULL,
  "node_id"       varchar(20) NOT NULL,
  "grantee_type"  varchar(8)  NOT NULL,
  "grantee_id"    varchar(20) NOT NULL,
  "permission"    varchar(8)  NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_cloud_node_grant" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_cloud_grant_node" ON "cloud_node_grant" ("node_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cloud_grant_unique" ON "cloud_node_grant" ("node_id", "grantee_type", "grantee_id");
```

- [ ] **Step 4: 错误码** — `main.error-codes.ts` 在 `SKILL_FORBIDDEN`（2012）后追加：

```typescript
  DRIVE_NODE_NOT_FOUND: { code: 2013, message: "drive.nodeNotFound" },
  DRIVE_FORBIDDEN: { code: 2014, message: "drive.forbidden", httpStatus: 403 },
  DRIVE_QUOTA_EXCEEDED: { code: 2015, message: "drive.quotaExceeded" },
  DRIVE_INVALID_MOVE: { code: 2016, message: "drive.invalidMove" },
  DRIVE_NAME_CONFLICT: { code: 2017, message: "drive.nameConflict" },
  DRIVE_NOT_READY: { code: 2018, message: "drive.notReady" },
```

加对应 i18n key 到 `apps/server-main/i18n/{zh,en}/`（参考现有 `org.*`/`skill.*` 的落点文件，新建 `drive.json` 或并入既有；先 `ls apps/server-main/i18n/zh`）。

- [ ] **Step 5: 注册 Entity** — 把 `CloudNode`/`CloudNodeGrant` 加入 `libs/main` 的 entities barrel + 确认 server-main 的 TypeORM entities 列表能扫到（`rg -n "SkillVersion" libs/main/src apps/server-main/src` 找注册点，照同样方式加）。

- [ ] **Step 6: typecheck + 围栏 + commit** — `pnpm turbo typecheck --filter=@meshbot/main`；`pnpm check:error-code`（新码登记，按提示更新 baseline）；`pnpm check:pk`（Entity 继承 SnowflakeBaseEntity）；`git commit -m "feat(server-main): cloud_node/cloud_node_grant Entity + DDL + DRIVE 错误码"`

---

## Task 3: resolvePermission 纯逻辑 + 单测

**Files:**
- Create: `libs/main/src/services/drive-acl.ts`
- Test: `libs/main/src/services/drive-acl.spec.ts`

**Interfaces:**
- Consumes: `CloudNode`、`CloudNodeGrant`（Task 2）。
- Produces: `type DrivePermission = "owner" | "editor" | "viewer"`。
- Produces: `resolvePermission(ctx: { userId: string; orgId: string }, node: CloudNode, chainGrants: CloudNodeGrant[]): DrivePermission | null`——`chainGrants` = node 自身 + 所有祖先的 grant 合集（调用方查好传入）。

- [ ] **Step 1: 写失败测试** — `drive-acl.spec.ts`：

```typescript
import { resolvePermission } from "./drive-acl";

const node = (over: Partial<any> = {}) =>
  ({ id: "n1", ownerUserId: "owner", orgId: "o1", ...over }) as any;
const grant = (over: Partial<any>) =>
  ({ granteeType: "user", granteeId: "u1", permission: "viewer", ...over }) as any;

describe("resolvePermission", () => {
  it("owner 恒为 owner（无视 grant）", () => {
    expect(resolvePermission({ userId: "owner", orgId: "o1" }, node(), [])).toBe("owner");
  });
  it("无 grant 且非 owner → null（私有）", () => {
    expect(resolvePermission({ userId: "x", orgId: "o1" }, node(), [])).toBeNull();
  });
  it("user grant 命中 → 该 permission", () => {
    expect(resolvePermission({ userId: "u1", orgId: "o1" }, node(), [grant({ permission: "editor" })])).toBe("editor");
  });
  it("org grant：同 org 命中", () => {
    expect(resolvePermission({ userId: "x", orgId: "o1" }, node(), [grant({ granteeType: "org", granteeId: "o1", permission: "viewer" })])).toBe("viewer");
  });
  it("org grant：异 org 不命中 → null", () => {
    expect(resolvePermission({ userId: "x", orgId: "oZ" }, node(), [grant({ granteeType: "org", granteeId: "o1" })])).toBeNull();
  });
  it("多 grant 取最高（editor > viewer）", () => {
    const gs = [grant({ permission: "viewer" }), grant({ granteeType: "org", granteeId: "o1", permission: "editor" })];
    expect(resolvePermission({ userId: "u1", orgId: "o1" }, node(), gs)).toBe("editor");
  });
});
```

- [ ] **Step 2: 跑验证失败** — `pnpm test -- drive-acl`，Expected: FAIL。

- [ ] **Step 3: 实现** — `drive-acl.ts`：

```typescript
import type { CloudNode } from "../entities/cloud-node.entity";
import type { CloudNodeGrant } from "../entities/cloud-node-grant.entity";

/** 网盘权限级别：owner > editor > viewer。 */
export type DrivePermission = "owner" | "editor" | "viewer";

const RANK: Record<DrivePermission, number> = { viewer: 1, editor: 2, owner: 3 };

/**
 * 判定用户对某节点的有效权限（Google Drive 式继承）。
 * @param ctx 当前用户 + 当前组织（org 来自 token.orgId）
 * @param node 目标节点（owner 恒为全权）
 * @param chainGrants node 自身 + 全部祖先的 grant 合集（调用方查好传入）
 * @returns 最高命中权限；无命中且非 owner → null（无权访问）
 */
export function resolvePermission(
  ctx: { userId: string; orgId: string },
  node: CloudNode,
  chainGrants: CloudNodeGrant[],
): DrivePermission | null {
  if (node.ownerUserId === ctx.userId) {
    return "owner";
  }
  let best: DrivePermission | null = null;
  for (const g of chainGrants) {
    const hit =
      (g.granteeType === "user" && g.granteeId === ctx.userId) ||
      (g.granteeType === "org" && g.granteeId === ctx.orgId);
    if (!hit) continue;
    const p = g.permission as DrivePermission;
    if (best === null || RANK[p] > RANK[best]) {
      best = p;
    }
  }
  return best;
}
```

- [ ] **Step 4: 跑验证通过** — `pnpm test -- drive-acl`，Expected: PASS（6/6）。
- [ ] **Step 5: commit** — `git commit -m "feat(server-main): resolvePermission 网盘 ACL 继承判定纯逻辑"`

---

## Task 4: CloudNode + CloudNodeGrant 归属 service

**Files:**
- Create: `libs/main/src/services/cloud-node.service.ts`、`libs/main/src/services/cloud-node-grant.service.ts`
- Modify: `libs/main` 的 module（`TxTypeOrmModule.forFeature([CloudNode, CloudNodeGrant, ...])` + providers + exports；`rg -n "SkillPackageService" libs/main/src` 找 module 注册点）
- Test: `libs/main/src/services/cloud-node.service.spec.ts`（in-memory better-sqlite3，参考 `apps/server-agent/src/services/schedule-executor.service.spec.ts` 的 DataSource 建法）

**Interfaces:**
- Produces `CloudNodeService`：
  - `listChildren(orgId, parentId: string | null): Promise<CloudNode[]>`（status='ready' + parentId 匹配 + orgId）
  - `findById(id): Promise<CloudNode | null>`
  - `listAncestors(node): Promise<CloudNode[]>`（沿 parentId 向上，不含自身）
  - `createFolderRow(orgId, ownerUserId, parentId, name): Promise<CloudNode>`
  - `createUploadingRow(orgId, ownerUserId, parentId, name, mime): Promise<CloudNode>`（status='uploading'；内部 create+save 拿雪花 id 后，置 `assetKey = drive/<orgId>/<id>` 再 update，返回含 assetKey 的 node。注意 [[snowflake-beforeinsert-gotcha]]：必须 repo.create()+save() 触发 @BeforeInsert 生成 id，不能 plain-object save / .insert()）
  - `markReady(id, sizeBytes, checksum): Promise<void>`
  - `rename(id, name): Promise<void>` / `move(id, parentId): Promise<void>`
  - `delete(id): Promise<void>`（单节点；递归在编排层）
  - `nameExists(orgId, parentId, name): Promise<boolean>`
  - `sumOrgReadySize(orgId): Promise<number>`
  - `listStaleUploading(beforeMs): Promise<CloudNode[]>`
- Produces `CloudNodeGrantService`：
  - `listForNodes(nodeIds: string[]): Promise<CloudNodeGrant[]>`、`listForNode(nodeId)`、`replaceForNode(nodeId, grants): Promise<void>`（删旧 + 插新）、`deleteForNode(nodeId)`。

- [ ] **Step 1: 写测试** — `cloud-node.service.spec.ts`，in-memory DataSource（entities: [CloudNode, CloudNodeGrant]，synchronize:true）。覆盖：createFolderRow → listChildren 含它；listAncestors 沿链；nameExists 同名 true；sumOrgReadySize 只算 ready+file；move 改 parentId；delete 移除。给至少 5 个用例（实现者按上面接口逐一断言）。示例：

```typescript
it("createFolderRow + listChildren", async () => {
  const f = await svc.createFolderRow("o1", "u1", null, "docs");
  const kids = await svc.listChildren("o1", null);
  expect(kids.map((k) => k.id)).toContain(f.id);
  expect(f.type).toBe("folder");
  expect(f.status).toBe("ready");
});
it("sumOrgReadySize 只统计 ready 文件", async () => {
  const up = await svc.createUploadingRow("o1", "u1", null, "a.bin", "drive/o1/x", "application/octet-stream");
  expect(await svc.sumOrgReadySize("o1")).toBe(0); // uploading 不计
  await svc.markReady(up.id, 100, "sum");
  expect(await svc.sumOrgReadySize("o1")).toBe(100);
});
```

- [ ] **Step 2: 跑验证失败** — `pnpm test -- cloud-node.service`，Expected: FAIL。

- [ ] **Step 3: 实现 CloudNodeService** — `@InjectRepository(CloudNode)`；关键方法（`bigint` 读出转 Number）：

```typescript
  /** 列目录子节点（仅 ready）。 */
  async listChildren(orgId: string, parentId: string | null): Promise<CloudNode[]> {
    return this.repo.find({
      where: { orgId, parentId: parentId ?? IsNull(), status: "ready" },
      order: { type: "ASC", name: "ASC" },
    });
  }
  /** 沿 parent 链向上收集祖先（不含自身）。 */
  async listAncestors(node: CloudNode): Promise<CloudNode[]> {
    const out: CloudNode[] = [];
    let cur = node.parentId;
    while (cur) {
      const p = await this.repo.findOne({ where: { id: cur } });
      if (!p) break;
      out.push(p);
      cur = p.parentId;
    }
    return out;
  }
  /** org 已用空间（ready 文件 size 之和）。 */
  async sumOrgReadySize(orgId: string): Promise<number> {
    const row = await this.repo
      .createQueryBuilder("n")
      .select("COALESCE(SUM(n.size_bytes), 0)", "total")
      .where("n.org_id = :orgId AND n.type = 'file' AND n.status = 'ready'", { orgId })
      .getRawOne<{ total: string }>();
    return Number(row?.total ?? 0);
  }
```

其余方法（createFolderRow/createUploadingRow/markReady/rename/move/delete/nameExists/findById/listStaleUploading）按接口签名用 repo 直接实现（create/save/update/delete/count/find）。`IsNull` from typeorm。

- [ ] **Step 4: 实现 CloudNodeGrantService** — `@InjectRepository(CloudNodeGrant)`：`listForNodes(ids)` 用 `In(ids)`；`replaceForNode` 先 `delete({ nodeId })` 再 `save(create(...))` 数组（单表删+插，不跨表，**不需 @Transactional**，但若想原子可挂；本表单表故不挂）。

- [ ] **Step 5: 模块注册** — `TxTypeOrmModule.forFeature([CloudNode, CloudNodeGrant])`（替代 TypeOrmModule.forFeature）+ providers + exports 两个 service。

- [ ] **Step 6: 跑测试 + 围栏 + commit** — `pnpm test -- cloud-node.service` PASS；`pnpm check:repo`（确认 CloudNode/Grant 各唯一归属）；`git commit -m "feat(server-main): CloudNode/CloudNodeGrant 归属 service"`

---

## Task 5: CloudDriveService 编排 + DTO

**Files:**
- Create: `libs/main/src/services/cloud-drive.service.ts`
- Create: `libs/types-main/src/drive.ts`（schema）、`libs/main/src/dto/`（DTO class）
- Modify: libs/main module（provider + export CloudDriveService）+ 配置（DRIVE_ORG_QUOTA_BYTES / DRIVE_UPLOAD_TTL）
- Test: `libs/main/src/services/cloud-drive.service.spec.ts`（mock CloudNodeService/CloudNodeGrantService/AssetService —— 编排逻辑单测，不连 DB/Minio）

**Interfaces:**
- Consumes: `CloudNodeService`/`CloudNodeGrantService`（Task 4）、`AssetService.getUploadUrl/getSignedUrl/stat/delete`（Task 1）、`resolvePermission`（Task 3）。
- Produces `CloudDriveService`（每方法第一参 `ctx: { userId: string; orgId: string }`）：
  - `listNodes(ctx, parentId): Promise<NodeView[]>`
  - `listShared(ctx): Promise<NodeView[]>`
  - `quota(ctx): Promise<{ used: number; limit: number }>`
  - `createFolder(ctx, parentId, name): Promise<NodeView>`
  - `requestUpload(ctx, { name, parentId, size, mime }): Promise<{ nodeId: string; putUrl: string }>`
  - `completeUpload(ctx, nodeId, checksum?): Promise<NodeView>`
  - `getDownloadUrl(ctx, id): Promise<{ url: string; ttl: number }>`
  - `rename(ctx, id, name)` / `move(ctx, id, parentId)`
  - `deleteNode(ctx, id): Promise<void>`
  - `listGrants(ctx, id)` / `setGrants(ctx, id, grants)`
- `NodeView = { id, type, name, sizeBytes, mime, status, permission, createdAt, updatedAt }`。

- [ ] **Step 1: schema + DTO** — `libs/types-main/src/drive.ts`（Zod，导出方式对齐 `create-org.schema.ts`）：

```typescript
import { z } from "zod";
export const CreateFolderSchema = z.object({ name: z.string().min(1).max(256), parentId: z.string().nullable() });
export const RequestUploadSchema = z.object({ name: z.string().min(1).max(256), parentId: z.string().nullable(), size: z.number().int().nonnegative(), mime: z.string().max(128) });
export const CompleteUploadSchema = z.object({ checksum: z.string().max(64).optional() });
export const RenameOrMoveSchema = z.object({ name: z.string().min(1).max(256).optional(), parentId: z.string().nullable().optional() });
const GrantSchema = z.object({ granteeType: z.enum(["org", "user"]), granteeId: z.string().min(1), permission: z.enum(["viewer", "editor"]) });
export const SetGrantsSchema = z.object({ grants: z.array(GrantSchema) });
export type RequestUploadInput = z.infer<typeof RequestUploadSchema>;
export type SetGrantsInput = z.infer<typeof SetGrantsSchema>;
```

对应 `libs/main/src/dto/` 加 `createZodDto` 的 DTO class（`CreateFolderDto`/`RequestUploadDto`/`CompleteUploadDto`/`RenameOrMoveDto`/`SetGrantsDto`），对齐既有 dto/index.ts 写法。

- [ ] **Step 2: 写编排单测** — `cloud-drive.service.spec.ts`，mock 三个依赖。核心断言（实现者按接口逐一覆盖）：
  - `requestUpload`：父无 editor 权限 → `DRIVE_FORBIDDEN`；配额超 → `DRIVE_QUOTA_EXCEEDED`；正常 → 调 createUploadingRow + getUploadUrl，返回 putUrl。
  - `completeUpload`：调 asset.stat 真实 size → markReady；超配额 → 删 Minio + 节点 + 抛 `DRIVE_QUOTA_EXCEEDED`。
  - `getDownloadUrl`：uploading 节点 → `DRIVE_NOT_READY`；viewer 权限 → getSignedUrl。
  - `move`：目标是自身子孙 → `DRIVE_INVALID_MOVE`。
  - `createFolder`：同名 → `DRIVE_NAME_CONFLICT`。
  - ACL：无权 listNodes → `DRIVE_FORBIDDEN`/空。
  示例（requestUpload 配额）：

```typescript
it("requestUpload 超配额 → DRIVE_QUOTA_EXCEEDED", async () => {
  node.findById.mockResolvedValue(folder({ id: "p", ownerUserId: "u1" })); // 父，owner 自己
  node.sumOrgReadySize.mockResolvedValue(QUOTA - 10);
  await expect(svc.requestUpload(ctx, { name: "big", parentId: "p", size: 100, mime: "x" }))
    .rejects.toMatchObject({ code: MainErrorCode.DRIVE_QUOTA_EXCEEDED.code });
});
```

- [ ] **Step 3: 跑验证失败** — `pnpm test -- cloud-drive.service`，Expected: FAIL。

- [ ] **Step 4: 实现 CloudDriveService** — 关键编排逻辑：

  - **权限解析 helper**（私有）：`requirePermission(ctx, node, min)`：查 `listAncestors` → `grant.listForNodes([node.id, ...ancestorIds])` → `resolvePermission(ctx, node, chainGrants)`；`RANK[perm] < RANK[min]` 或 null → 抛 `DRIVE_FORBIDDEN`；返回 perm。
  - `listNodes`：parentId 非空时先对父 requirePermission viewer；`listChildren` → 对每个子节点批量解析 permission（复用父链 grant + 自身 grant）→ map NodeView。parentId 空（用户根）：列 `owner=ctx.userId 且 parentId=null` 的节点（用户自己的根）。
  - `requestUpload`：父 requirePermission editor（根则 owner 自身免检）；`sumOrgReadySize + size > DRIVE_ORG_QUOTA_BYTES` → `DRIVE_QUOTA_EXCEEDED`；`const node = await createUploadingRow(orgId, userId, parentId, name, mime)`（内部已置 `assetKey=drive/<orgId>/<id>`）；`assets.getUploadUrl(node.assetKey, DRIVE_UPLOAD_TTL)` → `{ nodeId: node.id, putUrl }`。
  - `completeUpload`：node 必须 uploading + 属当前 org；`assets.stat(assetKey)` 取真实 size；超配额 → `assets.delete` + 删节点 + `DRIVE_QUOTA_EXCEEDED`；否则 markReady(size, checksum)。
  - `getDownloadUrl`：requirePermission viewer；status≠ready → `DRIVE_NOT_READY`；`assets.getSignedUrl(assetKey, ttl)`。
  - `rename`：requirePermission editor + nameExists 检查 → `DRIVE_NAME_CONFLICT`。
  - `move`：requirePermission editor（源）+ 目标父 editor；防环：目标父的祖先链（+目标父自身）不能含被移动节点 → `DRIVE_INVALID_MOVE`。
  - `deleteNode`：requirePermission editor；文件夹递归——`@Transactional()` 私有 `deleteSubtreeInTx(node)`：BFS/DFS 收集子树所有节点 → 逐个 `assets.delete(assetKey)`（文件）+ `grant.deleteForNode` + `node.delete`。（跨多行 + 多表：cloud_node + cloud_node_grant，故 `@Transactional` + `*InTx` 命名。）
  - `setGrants`：requirePermission owner；`grant.replaceForNode(id, grants)`。
  - `quota`：`{ used: sumOrgReadySize(orgId), limit: DRIVE_ORG_QUOTA_BYTES }`。
  - `listShared`：`grant.listSharedRoots(ctx)`——查 grantee=user:me 或 org:myOrg 的节点，过滤掉祖先也被授权给我的（最浅）。**v1 简化**：先返回所有被直接授权给我/我 org 的节点（不做"最浅"去重）；在代码注释标注 TODO 最浅去重留 SP-C 优化时再做（log 说明简化，符合 no-silent-cap）。

  配置：`DRIVE_ORG_QUOTA_BYTES`（默认 `5 * 1024**3`）、`DRIVE_UPLOAD_TTL`（默认 3600 秒）从 app-config 读（先 Read `apps/server-main/src/config/app-config.schema.ts` 看 env 注入方式，加两个配置项）。

- [ ] **Step 5: 跑测试通过 + 围栏** — `pnpm test -- cloud-drive.service` PASS；`pnpm check:naming`（deleteSubtreeInTx 命名 + @Transactional）；`pnpm check:tx`。
- [ ] **Step 6: commit** — `git commit -m "feat(server-main): CloudDriveService 网盘编排（ACL/配额/presigned/递归删）"`

---

## Task 6: drive.controller（server-main）+ e2e

**Files:**
- Create: `apps/server-main/src/rest/drive.controller.ts`
- Modify: `apps/server-main/src/app.module.ts`（注册 controller，确认 libs/main module 已导出 service）
- Test: `apps/server-main/test/e2e/drive.e2e.spec.ts`

**Interfaces:** Consumes `CloudDriveService`（Task 5）、`@CurrentUser() JwtMainPayload`（含 orgId）。

- [ ] **Step 1: Controller** — `drive.controller.ts`（参考 `org.controller.ts` 结构；全局 JwtAuthGuard，非 @Public；`@Controller("drive")` → 全局 prefix 后为 `/api/drive`）：

```typescript
@Controller("drive")
export class DriveController {
  constructor(private readonly drive: CloudDriveService) {}

  private ctx(user: JwtMainPayload): { userId: string; orgId: string } {
    if (!user.orgId) throw new AppError(MainErrorCode.ORG_NOT_FOUND);
    return { userId: user.userId, orgId: user.orgId };
  }

  @Get("nodes")
  listNodes(@CurrentUser() u: JwtMainPayload, @Query("parentId") parentId?: string) {
    return this.drive.listNodes(this.ctx(u), parentId ?? null);
  }
  @Get("shared")
  listShared(@CurrentUser() u: JwtMainPayload) { return this.drive.listShared(this.ctx(u)); }
  @Get("quota")
  quota(@CurrentUser() u: JwtMainPayload) { return this.drive.quota(this.ctx(u)); }
  @Post("folders")
  createFolder(@CurrentUser() u: JwtMainPayload, @Body() dto: CreateFolderDto) {
    return this.drive.createFolder(this.ctx(u), dto.parentId, dto.name);
  }
  @Post("uploads")
  requestUpload(@CurrentUser() u: JwtMainPayload, @Body() dto: RequestUploadDto) {
    return this.drive.requestUpload(this.ctx(u), dto);
  }
  @Post("uploads/:nodeId/complete") @HttpCode(200)
  completeUpload(@CurrentUser() u: JwtMainPayload, @Param("nodeId") nodeId: string, @Body() dto: CompleteUploadDto) {
    return this.drive.completeUpload(this.ctx(u), nodeId, dto.checksum);
  }
  @Get("files/:id/url")
  downloadUrl(@CurrentUser() u: JwtMainPayload, @Param("id") id: string) {
    return this.drive.getDownloadUrl(this.ctx(u), id);
  }
  @Patch("nodes/:id")
  patch(@CurrentUser() u: JwtMainPayload, @Param("id") id: string, @Body() dto: RenameOrMoveDto) {
    if (dto.name !== undefined) return this.drive.rename(this.ctx(u), id, dto.name);
    return this.drive.move(this.ctx(u), id, dto.parentId ?? null);
  }
  @Delete("nodes/:id")
  remove(@CurrentUser() u: JwtMainPayload, @Param("id") id: string) {
    return this.drive.deleteNode(this.ctx(u), id);
  }
  @Get("nodes/:id/grants")
  listGrants(@CurrentUser() u: JwtMainPayload, @Param("id") id: string) { return this.drive.listGrants(this.ctx(u), id); }
  @Put("nodes/:id/grants")
  setGrants(@CurrentUser() u: JwtMainPayload, @Param("id") id: string, @Body() dto: SetGrantsDto) {
    return this.drive.setGrants(this.ctx(u), id, dto.grants);
  }
}
```

- [ ] **Step 2: e2e** — `drive.e2e.spec.ts`，mock AssetService（presigned/stat/delete 返回桩），覆盖 spec §10：建夹 → 列目录含它；上传两阶段（requestUpload 返 putUrl + uploading 节点不在 list；completeUpload 后 ready 入 list + 计入 quota）；改名/移动（防环 → DRIVE_INVALID_MOVE）；删除文件夹递归（子节点 + grant 清掉 + asset.delete 调用）；配额超限 → DRIVE_QUOTA_EXCEEDED；**ACL 矩阵**（B 对 A 的私有节点 listNodes/downloadUrl → DRIVE_FORBIDDEN；A setGrants 给 B viewer 后 B 可 list 不可 delete；editor 可 upload）；继承（A 共享文件夹给 B → B 可见子文件）；listShared 返回被授权节点。
  **降级预案**（Postgres 不可达）：把 e2e 改为 CloudDriveService + 真实 CloudNodeService/GrantService（in-memory better-sqlite3，like Task 4 spec）+ mock AssetService 的集成测试，覆盖同样场景（ACL 矩阵/继承/配额/递归删/防环）。报告写清用 e2e 还是降级集成测试。

- [ ] **Step 3: 跑测试 + typecheck + commit** — `pnpm test -- drive`；`pnpm turbo typecheck --filter=@meshbot/server-main`；boot 验证（`pnpm dev:server-main` 看 `DriveController {/api/drive}` 路由 Mapped + 无 DI 报错；Postgres 不可达起不来则降级 typecheck + 静态确认）；`git commit -m "feat(server-main): /api/drive 网盘接口 + e2e"`

---

## Task 7: server-agent 网盘网关

**Files:**
- Create: `apps/server-agent/src/controllers/drive.controller.ts`、`apps/server-agent/src/services/drive-gateway.service.ts`
- Modify: server-agent 模块注册（参考 `our-market.source.ts` / CloudOrgController 的 CloudClient + CloudIdentity 注入方式）
- Test: `apps/server-agent/src/services/drive-gateway.service.spec.ts`

**Interfaces:** Consumes server-main `/api/drive/*`（Task 6）、`CloudClientService`（get/post/del + token）、`CloudIdentityService`/`AccountContextService`（拿当前账号 cloudToken）。

- [ ] **Step 1: DriveGatewayService** — 纯 JSON 转发，每方法用当前账号 cloudToken 调 server-main 同名接口：

```typescript
@Injectable()
export class DriveGatewayService {
  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
  ) {}

  private async token(): Promise<string> {
    const id = await this.identity.get(this.account.getOrThrow());
    if (!id?.cloudToken) throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    return id.cloudToken;
  }

  async listNodes(parentId: string | null) {
    const q = parentId ? `?parentId=${encodeURIComponent(parentId)}` : "";
    return this.cloud.get(`/api/drive/nodes${q}`, await this.token());
  }
  async requestUpload(body: unknown) { return this.cloud.post("/api/drive/uploads", body, await this.token()); }
  // …其余 list/shared/quota/folders/complete/url/patch/delete/grants 同样转发，原样透传 server-main 响应（含 putUrl/url）
}
```

（确认 `CloudClientService` 是否有 `patch`/`put` 方法；无则用既有 `post`/`get`/`del` + server-agent controller 路由映射到 server-main 对应方法，或给 CloudClient 补 `patch`/`put`——先 Read `cloud-client.service.ts` 确认可用动词。）

- [ ] **Step 2: DriveController（server-agent）** — `@Controller("api/drive")`（server-agent 无全局 prefix，参考 CloudOrgController 的 `@Controller("api/orgs")`），各路由转发 DriveGatewayService，DTO 校验用 server-agent 既有风格。

- [ ] **Step 3: 单测** — `drive-gateway.service.spec.ts`：mock cloud（get/post 返回桩）+ identity（返回 cloudToken）+ account；断言每方法带 token 调对应 path、presigned putUrl/url 原样透传、无 token → AUTH_UNAUTHORIZED。

- [ ] **Step 4: 跑测试 + boot + commit** — `pnpm test -- drive-gateway`；`pnpm dev:server-agent` 看 `/api/drive/*` 路由 Mapped + 无 DI 报错；`git commit -m "feat(server-agent): 网盘网关代理 server-main /api/drive"`

---

## Task 8: 集成验证

- [ ] **Step 1: 全包 typecheck** — `pnpm typecheck` 全绿。
- [ ] **Step 2: 全量 jest** — `pnpm test`：除基线（session.e2e、use-global-events.spec）零新增失败；新增 drive 相关测试全过。
- [ ] **Step 3: 静态围栏** — `pnpm check` exit 0（check:repo 单一归属、check:pk、check:naming、check:error-code baseline、check:tx）。
- [ ] **Step 4: boot 双端** — server-main `/api/drive/*` + server-agent 网关 `/api/drive/*` 路由 Mapped、无 DI 报错。
- [ ] **Step 5: 手动冒烟（可选，需 Minio + Postgres）** — 建夹 → 请求上传拿 putUrl → 直传 Minio → complete → 列目录见文件 → 取下载 url → 直下；共享给同 org 另一用户 → 对方可见。

---

## Self-Review（已核对）

- **Spec 覆盖**：§3 数据模型（Task 2）；§4 ACL+继承（Task 3 纯逻辑 + Task 5 requirePermission 串祖先链）；§5 配额（Task 5 quota/requestUpload/completeUpload）；§6 全部 10 接口（Task 6 controller 逐一）；§7 presigned 两阶段 + 下载（Task 1 assets + Task 5 requestUpload/completeUpload/getDownloadUrl）；§8 libs/assets（Task 1）；§9 错误码（Task 2）；§10 测试（各 task TDD + Task 6 e2e + Task 8）；§11 文件全覆盖；server-agent 网关（Task 7）。
- **简化标注**：listShared 的"最浅去重"v1 简化为返回全部被授权节点，代码注释 + log 标注（no-silent-cap），留 SP-C 优化——这是有意 YAGNI，不是 gap。
- **类型一致**：`resolvePermission(ctx, node, chainGrants)`（Task 3）→ Task 5 requirePermission 调用一致；`ctx={userId,orgId}` 贯穿 Task 5/6；`NodeView`（Task 5）→ Task 6 返回；`AssetService.getUploadUrl/stat`（Task 1）→ Task 5 调用一致；`CloudNodeService`/`CloudNodeGrantService` 方法签名（Task 4）→ Task 5 消费一致。
- **占位符**：无 TBD；多处"先 Read/rg 确认"是真实代码核对指令（barrel 落点、config 注入、CloudClient 动词），非占位。
- **Postgres 约束**：每个 DB 相关 task 给了 in-memory better-sqlite3 / mock 降级预案（本环境 Postgres 不可达，SP-0 已验证此约束）。
