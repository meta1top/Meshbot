# 网盘对外公开分享（SP-D）实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 让网盘单个文件能生成公开短链，未登录的人通过链接预览/下载；agent 能创建（HITL）和下载公开链接。

**Architecture:** 新表 `cloud_share_link`（Postgres）+ `CloudShareLinkService`（libs/main）；server-main 鉴权端点（owner 建/列/撤销）+ 匿名 `@Public` 端点（取元信息 / 校验密码后绕 ACL 拿 presigned）；web-agent 创建弹窗；web-main `app/share/[token]` 匿名页；agent 工具 `drive_create_share`（HITL）/ `drive_fetch_share`。

**Tech Stack:** NestJS + TypeORM + Postgres（server-main）、Zod（types-main/types-agent）、LangGraph @Tool（libs/agent）、Next.js App Router（web-agent / web-main）、bcrypt、@meshbot/design。

## Global Constraints

- **云端轨 DDL**：纯 SQL DDL 文件 `apps/server-main/migrations/<YYYYMMDDHHmm>-<en-summary>.sql`，DBA 手动执行（服务不自动建表）；幂等（`IF NOT EXISTS`）+ 文件不可变 + 列名 snake_case + 逻辑外键（无 DB 外键约束，不用 `@ManyToOne`/`@JoinColumn`）。
- **Entity 单一归属**：`CloudShareLink` 仅 `CloudShareLinkService` 注入 `@InjectRepository`（check:repo）。Controller 不注入 Repository，经 Service 访问。跨 entity 读（CloudNode）通过注入 `CloudNodeService`，不注入其 Repository。
- **雪花 id**：`repo.create()+save()` 触发 `@BeforeInsert`（不用 plain-object save / `.insert()`）。bigint 列读出是 string，对外暴露数值用 `Number(...)`。
- **@Transactional**：仅跨表写（≥2 写动作）才挂；本 plan 的 share-link 都是单表写，**不挂** @Transactional。
- **types-\* 禁依赖 NestJS/TypeORM**；后端 `createZodDto(schema)` 转 DTO。跨域 schema 放 `libs/types-main`/`libs/types-agent`。
- **错误码**：`defineErrorCode`，MainErrorCode DRIVE_* 从 **2019** 起（2013-2018 已用）；AgentErrorCode 按 agent 域范围。check:error-code 校验无重复/无 gap。
- **配置**：server-main 用 `APP_CONFIG` token（`@Inject(APP_CONFIG) config: AppConfig`）+ `AppConfigSchema`（zod），**不用** process.env / @nestjs/config。
- **密码哈希**：`bcrypt`，`const BCRYPT_COST = 12`，`bcrypt.hash(pwd, BCRYPT_COST)` / `bcrypt.compare(pwd, hash)`。
- **token**：`randomBytes(9).toString("base64url")`（12 位 url-safe，`import { randomBytes } from "node:crypto"`）。
- **presigned TTL**：复用 `3600`（秒）——`DRIVE_DOWNLOAD_TTL` 不存在，新建独立 const `const SHARE_TTL = 3600`。
- **测试**：libs/agent 用 vitest；其余 jest。公开方法中文 JSDoc。中文 commit。
- **前置（运维）**：Minio CORS 允许 web-main origin（匿名页 img/iframe 直连 presigned）。

---

### Task 1: 后端数据模型（CloudShareLink entity + DDL + Service 核心 + 错误码）

**Files:**
- Create: `libs/main/src/entities/cloud-share-link.entity.ts`
- Create: `libs/main/src/services/cloud-share-link.service.ts`
- Create: `apps/server-main/migrations/202607010000-cloud-drive-share.sql`
- Modify: `libs/main/src/errors/main.error-codes.ts`（+3 码）
- Modify: libs/main 的 module（注册 `CloudShareLink` 到 `TxTypeOrmModule.forFeature([...])` + provide/export `CloudShareLinkService`）— 先 `rg "CloudNodeGrant" libs/main/src` 找到注册 CloudNode/CloudNodeGrant 的 module 文件，照同样方式加。
- Test: `libs/main/src/services/cloud-share-link.service.spec.ts`

**Interfaces:**
- Consumes: `SnowflakeBaseEntity`（`libs/common`）、`CloudNodeService.findById(id)`（返回 `CloudNode | null`，含 `ownerUserId/orgId/type/status/name/mime/sizeBytes/assetKey`）、`AssetService.getSignedUrl(key, ttl)`（`libs/assets`）、`AppError` + `MainErrorCode`。
- Produces: `CloudShareLinkService.create(ctx, nodeId, opts)` / `.resolveOrThrow(token)` / `.listForNode(ctx, nodeId)` / `.revoke(ctx, linkId)` / `.verifyPassword(link, password?)` / `.signDownload(node)`；`CloudShareLink` entity。

- [ ] **Step 1: 错误码（先加，Service 依赖）**

在 `libs/main/src/errors/main.error-codes.ts` 的 DRIVE_* 段（2018 之后）追加（与现有 `defineErrorCode` 写法一致）：
```ts
DRIVE_SHARE_NOT_FOUND: defineErrorCode(2019, "分享链接不存在或已撤销"),
DRIVE_SHARE_EXPIRED: defineErrorCode(2020, "分享链接已过期"),
DRIVE_SHARE_PASSWORD_INVALID: defineErrorCode(2021, "分享链接密码错误"),
```

- [ ] **Step 2: Entity**

`libs/main/src/entities/cloud-share-link.entity.ts`：
```ts
import { Column, CreateDateColumn, Entity, Index } from "typeorm";
import { SnowflakeBaseEntity } from "@meshbot/common"; // 对齐 cloud-node.entity 的 import 来源

/** 网盘文件公开分享短链 */
@Entity("cloud_share_link")
export class CloudShareLink extends SnowflakeBaseEntity {
  /** 公开短码（url-safe，唯一） */
  @Index({ unique: true })
  @Column({ type: "varchar" })
  token!: string;

  /** 指向 cloud_node（逻辑外键，仅 type=file） */
  @Column({ type: "bigint" })
  nodeId!: string;

  @Column({ type: "bigint" })
  orgId!: string;

  @Column({ type: "bigint" })
  createdByUserId!: string;

  /** bcrypt 哈希；null=无密码 */
  @Column({ type: "varchar", nullable: true })
  passwordHash!: string | null;

  /** null=永久 */
  @Column({ type: "timestamptz", nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  /** 软删；null=有效 */
  @Column({ type: "timestamptz", nullable: true })
  revokedAt!: Date | null;
}
```
先 Read `libs/main/src/entities/cloud-node.entity.ts` 对齐 `SnowflakeBaseEntity` 的实际 import 路径与 Column 风格。

- [ ] **Step 3: DDL**

`apps/server-main/migrations/202607010000-cloud-drive-share.sql`（对齐 `202606281703-cloud-drive.sql` 的风格）：
```sql
-- 网盘文件公开分享短链
CREATE TABLE IF NOT EXISTS cloud_share_link (
  id BIGINT PRIMARY KEY,
  token VARCHAR(32) NOT NULL,
  node_id BIGINT NOT NULL,
  org_id BIGINT NOT NULL,
  created_by_user_id BIGINT NOT NULL,
  password_hash VARCHAR(255),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cloud_share_link_token ON cloud_share_link (token);
CREATE INDEX IF NOT EXISTS ix_cloud_share_link_node ON cloud_share_link (node_id);
```

- [ ] **Step 4: 写 Service 单测（先失败）**

`cloud-share-link.service.spec.ts`——mock `CloudNodeService`（findById 返回 file node）、`AssetService`（getSignedUrl 返回固定 url）、repo（用 jest mock 或内存数组）。覆盖：
```ts
// create: owner 文件 → 生成 token(12位) + 入库; 非 owner → DRIVE_FORBIDDEN; 非 file/非 ready → DRIVE_NODE_NOT_FOUND
// create 带 password → passwordHash 非空且能 bcrypt.compare 通过; 带 expiresInDays=7 → expiresAt ≈ now+7d
// resolveOrThrow: 有效 → {link,node}; revoked → DRIVE_SHARE_NOT_FOUND; 过期 → DRIVE_SHARE_EXPIRED; node 不存在 → DRIVE_SHARE_NOT_FOUND
// verifyPassword: 无 passwordHash → true(任意); 有 → 密码对 true / 错 false / 缺 false
// revoke: owner → 置 revokedAt; 非 owner → DRIVE_FORBIDDEN
// listForNode: owner → 仅未撤销; 非 owner → DRIVE_FORBIDDEN
```
Run: `pnpm test -- cloud-share-link.service` → FAIL（service 未实现）。

- [ ] **Step 5: 实现 Service**

`cloud-share-link.service.ts`：
```ts
import { randomBytes } from "node:crypto";
import * as bcrypt from "bcrypt";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";

const BCRYPT_COST = 12;
const SHARE_TTL = 3600;

type Ctx = { userId: string };

/** 网盘文件公开分享短链服务 */
@Injectable()
export class CloudShareLinkService {
  constructor(
    @InjectRepository(CloudShareLink) private readonly repo: Repository<CloudShareLink>,
    private readonly node: CloudNodeService,
    private readonly assets: AssetService,
  ) {}

  /** owner 为单文件创建公开链接 */
  async create(ctx: Ctx, nodeId: string, opts: { expiresInDays?: number | null; password?: string }): Promise<CloudShareLink> {
    const n = await this.node.findById(nodeId);
    if (!n || n.status !== "ready" || n.type !== "file") throw new AppError(MainErrorCode.DRIVE_NODE_NOT_FOUND);
    if (n.ownerUserId !== ctx.userId) throw new AppError(MainErrorCode.DRIVE_FORBIDDEN);
    const passwordHash = opts.password ? await bcrypt.hash(opts.password, BCRYPT_COST) : null;
    const expiresAt = opts.expiresInDays ? new Date(Date.now() + opts.expiresInDays * 86_400_000) : null;
    const link = this.repo.create({
      token: randomBytes(9).toString("base64url"),
      nodeId, orgId: n.orgId, createdByUserId: ctx.userId,
      passwordHash, expiresAt, revokedAt: null,
    });
    return this.repo.save(link);
  }

  /** 解析公开 token，无效/撤销/过期/节点失效则抛 */
  async resolveOrThrow(token: string): Promise<{ link: CloudShareLink; node: CloudNode }> {
    const link = await this.repo.findOne({ where: { token } });
    if (!link || link.revokedAt) throw new AppError(MainErrorCode.DRIVE_SHARE_NOT_FOUND);
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) throw new AppError(MainErrorCode.DRIVE_SHARE_EXPIRED);
    const node = await this.node.findById(link.nodeId);
    if (!node || node.status !== "ready") throw new AppError(MainErrorCode.DRIVE_SHARE_NOT_FOUND);
    return { link, node };
  }

  /** 校验密码（无密码链接恒 true） */
  async verifyPassword(link: CloudShareLink, password?: string): Promise<boolean> {
    if (!link.passwordHash) return true;
    if (!password) return false;
    return bcrypt.compare(password, link.passwordHash);
  }

  /** 绕 ACL 生成下载 presigned（token 已是凭证） */
  async signDownload(node: CloudNode): Promise<{ url: string; name: string; mime: string }> {
    const url = await this.assets.getSignedUrl(node.assetKey ?? "", SHARE_TTL);
    return { url, name: node.name, mime: node.mime };
  }

  /** 列出某文件未撤销的链接（owner） */
  async listForNode(ctx: Ctx, nodeId: string): Promise<CloudShareLink[]> {
    const n = await this.node.findById(nodeId);
    if (!n || n.ownerUserId !== ctx.userId) throw new AppError(MainErrorCode.DRIVE_FORBIDDEN);
    return this.repo.find({ where: { nodeId, revokedAt: IsNull() }, order: { createdAt: "DESC" } });
  }

  /** 软删撤销（owner） */
  async revoke(ctx: Ctx, linkId: string): Promise<void> {
    const link = await this.repo.findOne({ where: { id: linkId } });
    if (!link) throw new AppError(MainErrorCode.DRIVE_SHARE_NOT_FOUND);
    const n = await this.node.findById(link.nodeId);
    if (!n || n.ownerUserId !== ctx.userId) throw new AppError(MainErrorCode.DRIVE_FORBIDDEN);
    await this.repo.update({ id: linkId }, { revokedAt: new Date() });
  }
}
```
补齐 import（`CloudShareLink`、`CloudNode`、`CloudNodeService`、`AssetService`、`AppError`、`MainErrorCode`）——Read `cloud-drive.service.ts` 对齐这些来源路径。

- [ ] **Step 6: 注册 module + 跑测试通过**

把 `CloudShareLink` 加进 libs/main module 的 `TxTypeOrmModule.forFeature([...])`，provide + export `CloudShareLinkService`。
Run: `pnpm test -- cloud-share-link.service` → PASS。`pnpm turbo typecheck --filter=@meshbot/main` 绿。

- [ ] **Step 7: Commit** `feat(server-main): 网盘公开分享数据模型 + Service`

---

### Task 2: 后端鉴权端点（创建 / 列 / 撤销）

**Files:**
- Create: `apps/server-main/src/rest/drive-share-link.controller.ts`（前缀对齐 `drive.controller.ts`）
- Create: schema in `libs/types-main`（`CreateShareLinkSchema` + DTO）
- Modify: server-main 的 controller 注册 module（加 `DriveShareLinkController`）
- Modify: `AppConfigSchema`（加 `webMainBase`）+ `conf/*.yml`（或 .env 示例）
- Test: `apps/server-main/test/...` e2e 或 controller 单测

**Interfaces:**
- Consumes: `CloudShareLinkService`（Task 1）、`APP_CONFIG`/`AppConfig`、`@CurrentUser()`（Read `drive.controller.ts` 确认拿 user 的装饰器与 ctx 形状 `{userId, orgId}`）。
- Produces: `POST /api/drive/nodes/:id/share-links` → `{token, url}`；`GET /api/drive/nodes/:id/share-links` → `ShareLinkView[]`；`DELETE /api/drive/share-links/:linkId` → `{ok:true}`。

- [ ] **Step 1: schema（types-main）**

```ts
export const CreateShareLinkSchema = z.object({
  expiresInDays: z.number().int().positive().nullable().optional(),
  password: z.string().min(1).optional(),
});
// → createZodDto(CreateShareLinkSchema) 作为 CreateShareLinkDto
```

- [ ] **Step 2: 配置加 webMainBase**

先 Read `app-config.schema.ts` + auth.controller 用 `config.jwt.expires` 的写法。在 `AppConfigSchema` 加：
```ts
webMainBase: z.string().url().default("http://localhost:3002"),
```
（用 default 避免现网缺配置崩；3002 是 web-main dev 端口。）

- [ ] **Step 3: 写 controller 测试（先失败）**

覆盖：owner 创建返回 `{token, url}`（url 以 webMainBase 开头 + `/share/`）；非 owner 创建 → 403/DRIVE_FORBIDDEN；list 返回数组；revoke 调 service.revoke。可走 e2e（参考现有 server-main e2e 模式，Postgres 不可达则按现有降级方式）或 controller 薄单测（mock service）。

- [ ] **Step 4: 实现 controller**

```ts
@Controller(/* 对齐 drive.controller: 如 "api/drive" 或全局 prefix + "drive" */)
export class DriveShareLinkController {
  constructor(
    private readonly service: CloudShareLinkService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private url(token: string): string {
    return `${this.config.webMainBase}/share/${token}`;
  }

  /** owner 为文件创建公开链接 */
  @Post("nodes/:id/share-links")
  async create(@CurrentUser() user: { userId: string }, @Param("id") id: string, @Body() dto: CreateShareLinkDto) {
    const link = await this.service.create({ userId: user.userId }, id, dto);
    return { token: link.token, url: this.url(link.token) };
  }

  /** 列出某文件的有效公开链接 */
  @Get("nodes/:id/share-links")
  async list(@CurrentUser() user: { userId: string }, @Param("id") id: string) {
    const links = await this.service.listForNode({ userId: user.userId }, id);
    return links.map((l) => ({
      id: l.id, token: l.token, url: this.url(l.token),
      expiresAt: l.expiresAt, requiresPassword: !!l.passwordHash, createdAt: l.createdAt,
    }));
  }

  /** 撤销公开链接 */
  @Delete("share-links/:linkId")
  async revoke(@CurrentUser() user: { userId: string }, @Param("linkId") linkId: string) {
    await this.service.revoke({ userId: user.userId }, linkId);
    return { ok: true };
  }
}
```
注册到 module 的 controllers 数组。

- [ ] **Step 5: 测试通过 + typecheck**

Run controller 测试 PASS；`pnpm turbo typecheck --filter=@meshbot/server-main` 绿。

- [ ] **Step 6: Commit** `feat(server-main): 网盘公开分享鉴权端点（建/列/撤销）`

---

### Task 3: 后端匿名端点（@Public）

**Files:**
- Create: `apps/server-main/src/rest/public-share.controller.ts`
- Create: schema `ShareDownloadSchema`（types-main）
- Modify: module 注册 `PublicShareController`
- Test: controller/e2e 测试（匿名访问）

**Interfaces:**
- Consumes: `CloudShareLinkService.resolveOrThrow/verifyPassword/signDownload`、`@Public()`（`apps/server-main/src/auth/public.decorator.ts`）。
- Produces: `GET /api/share/:token` → `{name, sizeBytes, mime, requiresPassword}`；`POST /api/share/:token/download` `{password?}` → `{url, name, mime}`。

- [ ] **Step 1: schema**
```ts
export const ShareDownloadSchema = z.object({ password: z.string().optional() }); // → ShareDownloadDto
```

- [ ] **Step 2: 写测试（先失败）**

覆盖：匿名 GET 有效 token → 元信息（不含 nodeId/orgId）；撤销/过期 → 抛对应错误；POST download 无密码链接 → 返回 url；有密码链接缺/错密码 → DRIVE_SHARE_PASSWORD_INVALID；密码对 → 返回 presigned url。确认这两个端点**无需 JWT**（@Public 生效）。

- [ ] **Step 3: 实现 controller**
```ts
@Controller("api/share") // 对齐现有匿名 controller 前缀风格（Read skill.controller）
export class PublicShareController {
  constructor(private readonly service: CloudShareLinkService) {}

  /** 取公开文件元信息（不暴露内部 id） */
  @Public()
  @Get(":token")
  async info(@Param("token") token: string) {
    const { link, node } = await this.service.resolveOrThrow(token);
    return { name: node.name, sizeBytes: Number(node.sizeBytes), mime: node.mime, requiresPassword: !!link.passwordHash };
  }

  /** 校验密码后返回 presigned 下载 URL */
  @Public()
  @Post(":token/download")
  async download(@Param("token") token: string, @Body() dto: ShareDownloadDto) {
    const { link, node } = await this.service.resolveOrThrow(token);
    const ok = await this.service.verifyPassword(link, dto.password);
    if (!ok) throw new AppError(MainErrorCode.DRIVE_SHARE_PASSWORD_INVALID);
    return this.service.signDownload(node);
  }
}
```

- [ ] **Step 4: 测试通过 + typecheck + 围栏**

Run 测试 PASS；`pnpm turbo typecheck --filter=@meshbot/server-main`；`pnpm check:error-code`（新码登记）+ `pnpm check:repo`（CloudShareLink 单一归属）绿。

- [ ] **Step 5: Commit** `feat(server-main): 网盘公开分享匿名端点（@Public + 绕 ACL presigned）`

---

### Task 4: web-agent 创建/管理 UI

**Files:**
- Modify: `apps/web-agent/src/rest/drive.ts`（+3 fn/hooks）
- Create: `apps/web-agent/src/components/drive/drive-share-link-modal.tsx`
- Modify: `apps/web-agent/src/components/drive/drive-file-list.tsx`（菜单加「公开链接」，仅 owner）
- Modify: i18n `messages/zh.json` + `en.json`

**Interfaces:**
- Consumes: `apiClient`（post/get/delete）、`DriveNode`（含 `permission`）、`@meshbot/design`（Dialog/Button/Input/Select/DropdownMenu）。
- Produces: `useShareLinks(nodeId)` / `useCreateShareLink(nodeId)` / `useRevokeShareLink(nodeId)`；`DriveShareLinkModal`。

- [ ] **Step 1: rest 扩展**

仿 Task 1（SP-C）的 rest/drive.ts 风格加：
```ts
export type ShareLinkView = { id: string; token: string; url: string; expiresAt: string | null; requiresPassword: boolean; createdAt: string };

export function createShareLink(nodeId: string, body: { expiresInDays?: number | null; password?: string }) {
  return apiClient.post<{ token: string; url: string }>(`/api/drive/nodes/${nodeId}/share-links`, body).then((r) => r.data);
}
export function listShareLinks(nodeId: string) {
  return apiClient.get<ShareLinkView[]>(`/api/drive/nodes/${nodeId}/share-links`).then((r) => r.data);
}
export function revokeShareLink(linkId: string) {
  return apiClient.delete(`/api/drive/share-links/${linkId}`).then((r) => r.data);
}
// hooks: useShareLinks(nodeId) useQuery(["drive","share-links",nodeId], enabled: !!nodeId)
// useCreateShareLink / useRevokeShareLink useMutation onSuccess → invalidate ["drive","share-links",nodeId]
```

- [ ] **Step 2: DriveShareLinkModal**

`drive-share-link-modal.tsx`（props `{ nodeId, open, onClose }`，Rules-of-Hooks：hooks 在 `if(!open) return null` 之前）：
- `useShareLinks(nodeId)` 列已有链接：每条显示 url（只读 input + 复制按钮 `navigator.clipboard.writeText`）、过期/加密标识、撤销按钮（`useRevokeShareLink`）。
- 新建区：过期下拉（7 天 / 30 天 / 永久 → expiresInDays 7/30/null）+ 可选密码 input → 「创建」`useCreateShareLink` → 成功后列表 invalidate，新链接出现。
- 关闭重置表单 state（仿 SP-C drive-share-modal 的 `useEffect(()=>{ if(!open) reset() },[open])`）。

- [ ] **Step 3: 接入文件行菜单**

`drive-file-list.tsx` 行 DropdownMenu 加「公开链接」项（仅 `isOwner`，与「共享」并列）→ 打开 `DriveShareLinkModal({ nodeId: node.id })`。仅 file 行显示（文件夹不可公开分享）。

- [ ] **Step 4: i18n + 验证**

补 `drive.shareLink*` 文案（标题/过期选项/密码/复制/撤销/创建/空态）+ `pnpm sync:locales --write`。
Run: `pnpm turbo typecheck --filter=@meshbot/web-agent` 绿；`npx biome check --write` 改动文件。

- [ ] **Step 5: Commit** `feat(web-agent): 网盘公开链接创建/管理弹窗`

---

### Task 5: web-main 匿名公开页

**Files:**
- Create: `apps/web-main/src/app/share/[token]/page.tsx`
- Create: `apps/web-main/src/app/share/[token]/share-view.tsx`（client component）
- Possibly: `apps/web-main/src/rest/share.ts`（匿名 fetch）
- Modify: i18n（web-main messages，若有；否则页面内文案走现有 IntlProvider）

**Interfaces:**
- Consumes: web-main 无 react-query → 用 client component（`"use client"`）+ `useState`/`useEffect` + `fetch`（或 `createApiClient` from `@meshbot/web-common`，匿名无 token 不会附加 header）。后端 `GET /api/share/:token` + `POST /api/share/:token/download`。`@meshbot/design` 组件。
- Produces: 匿名公开页（元信息 + 密码输入 + 图片/PDF 内联 + 下载）。

> 注意：web-main 当前 `app/layout.tsx` 仅包 `<IntlProvider>`，无鉴权拦截，新增 `app/share/[token]` 路由不冲突。API base：调用 server-main，base URL 用 web-main 现有的 API 配置（Read web-main 是否有 env/NEXT_PUBLIC_API_BASE；若无则用相对路径或新增 env）。

- [ ] **Step 1: page.tsx（薄壳）**
```tsx
// app/share/[token]/page.tsx — server component 薄壳，传 token 给 client view
export default function SharePage({ params }: { params: { token: string } }) {
  return <ShareView token={params.token} />;
}
```

- [ ] **Step 2: share-view.tsx（client）**
```tsx
"use client";
// 状态机: loading → (notFound|expired) | needPassword | ready
// 1. useEffect: GET /api/share/:token → {name,sizeBytes,mime,requiresPassword}; 4xx → 失效提示
// 2. requiresPassword 且未解锁 → 密码输入框 + 提交
// 3. 解锁/无密码 → POST /api/share/:token/download {password} → {url,mime}
//    图片(mime startsWith image/) → <img src=url>
//    pdf(mime==application/pdf) → <iframe src=url>
//    其它 → 文件名/大小 + 「下载」按钮(a.href=url download=name)
// 错误密码 → inline 提示重输
```
用 `@meshbot/design` 的 Card/Button/Input。失效页友好文案。

- [ ] **Step 3: 验证**

Run: `pnpm turbo typecheck --filter=@meshbot/web-main` 绿；`npx biome check --write`。静态导出若需 Suspense（useSearchParams 不用则免）——本页用 params 不涉及。

- [ ] **Step 4: Commit** `feat(web-main): 网盘公开分享匿名页`

---

### Task 6: agent 工具（drive_create_share HITL + drive_fetch_share）

**Files:**
- Modify: `libs/agent/src/tools/drive.port.ts`（+2 方法）
- Create: `libs/agent/src/tools/builtins/drive-create-share.tool.ts` + `drive-fetch-share.tool.ts`
- Modify: libs/agent agent.module（注册 2 工具）
- Create: schema in `libs/types-agent`（2 个）
- Modify: `apps/server-agent/src/services/drive-tool.service.ts`（+createShare/fetchShare）
- Modify: `apps/server-agent/src/services/drive-gateway.service.ts`（+转发）
- Modify: AgentErrorCode（+`DRIVE_SHARE_FETCH_FAILED`）
- Create: `apps/web-agent/src/components/session/drive-create-share-card.tsx` + `tool-call-block.tsx` 特判 + TOOL_LABELS
- Test: libs/agent vitest（2 工具）+ server-agent jest（DriveToolService）

**Interfaces:**
- Consumes: `DRIVE_PORT`、`ConfirmationService`（`.key(account, sessionId, toolCallId)` + `waitForDecision(key, signal, 120_000)` 四态）、`DriveGatewayService`、`getWorkspaceDir()` + 越界校验、裸 fetch。
- Produces: `drive_create_share`（HITL）+ `drive_fetch_share` 工具；`DrivePort.createShare/fetchShare`。

- [ ] **Step 1: schema（types-agent）**
```ts
export const DriveCreateShareInput = z.object({
  nodeId: z.string(),
  expiresInDays: z.number().int().positive().nullable().optional(),
  password: z.string().min(1).optional(),
});
export const DriveFetchShareInput = z.object({
  token: z.string(),         // 公开链接末段的 token（提示 LLM 从 URL 提取）
  destPath: z.string(),      // workspace 相对路径
  password: z.string().optional(),
});
```

- [ ] **Step 2: DrivePort 扩 + 转发**

`drive.port.ts` 接口加：
```ts
createShare(args: { nodeId: string; expiresInDays?: number | null; password?: string; sessionId: string; toolCallId: string }, signal: AbortSignal): Promise<string>;
fetchShare(token: string, destPath: string, password: string | undefined): Promise<string>;
```
`drive-gateway.service.ts` 加：
```ts
async createShareLink(nodeId: string, body: unknown): Promise<unknown> {
  return this.cloud.post(`/api/drive/nodes/${encodeURIComponent(nodeId)}/share-links`, body, await this.token());
}
async resolveShare(token: string): Promise<unknown> {            // 匿名 GET，不带 token
  return this.cloud.get(`/api/share/${encodeURIComponent(token)}`);
}
async downloadShare(token: string, body: unknown): Promise<unknown> { // 匿名 POST
  return this.cloud.post(`/api/share/${encodeURIComponent(token)}/download`, body);
}
```
（确认 `CloudClientService.get/post` 支持无 token 调用——Read drive-gateway/cloud-client；匿名端点不传 Bearer。）

- [ ] **Step 3: 两个 @Tool（薄壳）**

`drive-create-share.tool.ts`（透传 ctx，HITL 在 service）：
```ts
@Tool()
export class DriveCreateShareTool implements MeshbotTool<DriveCreateShareInputT, string> {
  readonly name = "drive_create_share";
  // description: 为网盘文件创建公开分享链接（会请用户确认），返回 {token,url}
  constructor(@Inject(DRIVE_PORT) private readonly port: DrivePort) {}
  execute(args, ctx) {
    return this.port.createShare({ ...args, sessionId: ctx.sessionId, toolCallId: ctx.toolCallId }, ctx.signal);
  }
}
```
`drive-fetch-share.tool.ts`：
```ts
execute(args, _ctx) { return this.port.fetchShare(args.token, args.destPath, args.password); }
```
注册到 agent.module。

- [ ] **Step 4: DriveToolService 实现（vitest/jest 测试先行）**

`createShare`（仿 `share` 四态）：
```ts
async createShare(args, signal): Promise<string> {
  const key = ConfirmationService.key(this.account.getOrThrow(), args.sessionId, args.toolCallId);
  const outcome = await this.confirmation.waitForDecision(key, signal, 120_000);
  if (outcome === "timeout") return JSON.stringify({ status: "timeout" });
  if (outcome === "aborted") return JSON.stringify({ status: "interrupted" });
  if (outcome.action === "cancel") return JSON.stringify({ status: "cancelled" });
  const res = await this.gateway.createShareLink(args.nodeId, { expiresInDays: args.expiresInDays ?? null, password: args.password });
  return JSON.stringify({ status: "shared", ...(res as object) }); // {token,url}
}
```
`fetchShare`：
```ts
async fetchShare(token: string, destPath: string, password: string | undefined): Promise<string> {
  try {
    const { url } = (await this.gateway.downloadShare(token, { password })) as { url: string };
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const abs = /* getWorkspaceDir + resolve + 越界校验（仿 download 方法） */;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
    return JSON.stringify({ status: "downloaded", path: destPath });
  } catch (e) {
    throw new AppError(AgentErrorCode.DRIVE_SHARE_FETCH_FAILED, ...);
  }
}
```
测试（jest）：createShare 四态（确认→调 gateway.createShareLink / 取消→不调）；fetchShare（downloadShare→fetch→写 workspace；越界 destPath 拒；fetch 非 ok → DRIVE_SHARE_FETCH_FAILED）。vitest：两 @Tool execute 透传 + schema。

- [ ] **Step 5: 确认卡（web-agent）**

`drive-create-share-card.tsx`（复用 drive-share-card 模式）：pending 显示「为 <文件名/nodeId> 创建公开链接，过期 <…>，<带/不带>密码」+ 确认/取消（`confirmSend(sessionId, toolCallId, "send"|"cancel")`）；终态显示已创建（含 url）/已取消。`tool-call-block.tsx` 加特判：
```ts
if (tool.name === "drive_create_share" && tool.status !== "streaming") return <DriveCreateShareCard tool={tool} sessionId={sessionId} />;
```
TOOL_LABELS 补 `drive_create_share` / `drive_fetch_share` 友好中文名。

- [ ] **Step 6: 验证 + Commit**

Run: libs/agent vitest 相关 + server-agent jest 相关 PASS；`pnpm turbo typecheck` 全绿；`pnpm check:error-code`（agent 新码）。
Commit `feat(agent): drive_create_share(HITL) + drive_fetch_share 工具`。

---

### Task 7: 集成验证

- [ ] **Step 1:** `rm -rf apps/web-agent/.next apps/web-main/.next`；`pnpm typecheck`（全包 26+ successful）。
- [ ] **Step 2:** `pnpm test`（jest）——确认仅预存在基线失败（session.e2e + use-global-events），新增 share 测试通过、零新增回归（与基线 diff）。libs/agent vitest 相关绿。
- [ ] **Step 3:** `pnpm check`（全围栏 exit 0：error-code 新码登记、repo 单一归属、pk、tx 无新增）。
- [ ] **Step 4: 手动验证清单**（需 Postgres 跑 DDL + Minio COR(web-main) + 登录）：
  - web-agent 文件行「公开链接」→ 建链接（永久/带密码）→ 复制 url
  - 浏览器无痕打开 url → web-main 匿名页 → （输密码）→ 图片/PDF 内联 + 下载
  - 撤销链接 → 再访问 url → 失效提示
  - agent：`drive_create_share`（确认卡 → 确认 → 返回 url）；`drive_fetch_share`（token → 下载到 workspace）
- [ ] **Step 5: Commit**（若有验证期修复）。

---

## Self-Review 记录

- **Spec 覆盖**：§3 数据模型→T1；§4 鉴权端点→T2、匿名端点→T3；§5 绕 ACL→T1.signDownload + T3；§6 web-agent→T4；§7 web-main→T5；§8 agent 工具→T6；§9 错误码→T1、DDL→T1；§11 测试散布各 task；§13 拆分一致。
- **类型一致**：`{token,url}` 创建返回、`ShareLinkView`、`resolveOrThrow→{link,node}`、`createShare/fetchShare` 签名跨 task 一致。
- **校准点**：用 `SHARE_TTL=3600`（非不存在的 DRIVE_DOWNLOAD_TTL）；配置走 `APP_CONFIG`/zod；web-main 无 react-query 用 client component；bcrypt cost 12。
