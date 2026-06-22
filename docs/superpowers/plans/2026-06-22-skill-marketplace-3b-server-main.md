# SP3-3b：server-main 技能市场（Entity+DDL+Service+Controller，用 libs/assets 托管内容）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 `- [ ]`。

**Goal:** server-main 提供技能市场后端：发布(上传 tar.gz 到 minio + 写元数据)、检索列表/详情、下载技能包；为 SP3-3c 的 server-agent 安装/上传提供 API。

**Architecture:** 实体 `SkillPackage`/`SkillVersion`(libs/main，继承 `SnowflakeBaseEntity`，id=varchar(20)) → `SkillPackageService`(纯 DB CRUD，唯一持 `@InjectRepository`) → `SkillMarketService`(注入 SkillPackageService + `AssetService`，编排 DB+对象存储) → `SkillController`(apps/server-main/rest，list/detail/download 走 `@Public`，publish 走全局 JWT)。内容 tar.gz 经 base64 JSON 上传(无 multer)，存 minio(`AssetsModule` 设为 global)。schema 走 DDL 文件(DBA 手动执行)。

**Tech Stack:** NestJS 11、TypeORM、@meshbot/assets(3a)、Zod + nestjs-zod(createZodDto)、Postgres、root Jest(service 单测) + e2e(supertest，AssetService 用内存假实现覆盖)。

## Global Constraints
- 实体唯一归属 Service 持 `@InjectRepository`(check:repo)；Controller 不注入 Repository；跨表写 `@Transactional`(发布是跨 skill_package+skill_version 两表 → 需 `@Transactional`，方法名 `*InTx`/`persist*`，check:naming/lock-tx)；单表读不需要。
- 所有 Entity 继承 `SnowflakeBaseEntity`(check:pk)；id=varchar(20)，逻辑外键也 varchar(20)。
- server-main schema 走 DDL：新增 `apps/server-main/migrations/202606221200-skill-marketplace.sql`(幂等 IF NOT EXISTS、snake_case、无 DB 外键、文件不可变)。改 Entity 必配 DDL(ddl-migration 技能)。
- 跨域/域内 schema：市场对外类型放 `libs/types-main/src/skill.ts`(禁依赖 NestJS/TypeORM)；后端 DTO 用 `createZodDto`(libs/main/src/dto)。
- `AssetsModule.forRoot` 改为 global(libs/assets，便于 libs/main 的 SkillMarketService 注入 AssetService)。
- minio 配置加到 `apps/server-main/src/config/app-config.schema.ts` 的 `assets` 切片；AppModule.forRoot 接 `AssetsModule.forRoot({provider:"minio",minio:config.assets.minio})`。
- 对象 key 格式：`skills/<slug>/<version>.tar.gz`。
- 中文 JSDoc(公开方法)；提交中文 conventional，尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；每 Task 后 `pnpm check`(围栏) + 相关包 typecheck/lint + `biome check --write`。

## File Structure
- `apps/server-main/migrations/202606221200-skill-marketplace.sql` — DDL(skill_package + skill_version)。
- `libs/main/src/entities/skill-package.entity.ts` / `skill-version.entity.ts` — 实体。
- `libs/types-main/src/skill.ts` — 对外 Zod schema + 类型(summary/detail/publish)。
- `libs/main/src/dto/skill.dto.ts` — `PublishSkillDto = createZodDto(PublishSkillSchema)`。
- `libs/main/src/services/skill-package.service.ts` — 纯 DB(owns 两实体)。
- `libs/main/src/services/skill-market.service.ts` — DB + AssetService 编排。
- `libs/main/src/main.module.ts`(改) — forFeature 加两实体、providers 加两 service、exports 加 SkillMarketService。
- `libs/main/src/index.ts`(改) — 导出 SkillMarketService + DTO。
- `libs/assets/src/assets.module.ts`(改) — forRoot 设 `global: true`。
- `apps/server-main/src/config/app-config.schema.ts`(改) — 加 `assets` 切片。
- `apps/server-main/src/app.module.ts`(改) — import AssetsModule.forRoot、controllers 加 SkillController。
- `apps/server-main/src/rest/skill.controller.ts` — 端点。
- `apps/server-main/test/e2e/skill-flow.spec.ts` — e2e。

---

### Task 1: DDL + 实体 + 对外类型 + DTO

**Files:** Create 上述 DDL / 两实体 / `libs/types-main/src/skill.ts` / `libs/main/src/dto/skill.dto.ts`；Modify `libs/types-main/src/index.ts`(导出 skill)。

**Interfaces — Produces:**
```ts
// libs/types-main/src/skill.ts
export const MarketSkillSummarySchema = z.object({
  slug: z.string(), displayName: z.string(), description: z.string(),
  author: z.string(), latestVersion: z.string(), downloads: z.number(),
});
export type MarketSkillSummary = z.infer<typeof MarketSkillSummarySchema>;
export const SkillVersionInfoSchema = z.object({
  version: z.string(), changelog: z.string().nullable(), createdAt: z.string(),
});
export const MarketSkillDetailSchema = MarketSkillSummarySchema.extend({
  readme: z.string(),               // 最新版本的 SKILL.md 文本
  versions: z.array(SkillVersionInfoSchema),
});
export type MarketSkillDetail = z.infer<typeof MarketSkillDetailSchema>;
export const PublishSkillSchema = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string().min(1).max(128),
  description: z.string().min(1),
  version: z.string().min(1).max(32),
  changelog: z.string().optional(),
  readme: z.string().min(1),        // SKILL.md 文本(详情展示用，免每次下载解包)
  tarballBase64: z.string().min(1), // 技能目录 tar.gz 的 base64
});
export type PublishSkillInput = z.infer<typeof PublishSkillSchema>;
```

- [ ] **Step 1: DDL**

`apps/server-main/migrations/202606221200-skill-marketplace.sql`（沿用 init DDL 头部注释风格 + 幂等）：
```sql
-- skill 市场（SP3-3b）。DBA 手动执行；幂等；snake_case；逻辑外键；id 为雪花 varchar(20)。
CREATE TABLE IF NOT EXISTS "skill_package" (
  "id"             varchar(20)  NOT NULL,
  "slug"           varchar(64)  NOT NULL,
  "display_name"   varchar(128) NOT NULL,
  "description"    text         NOT NULL,
  "author_user_id" varchar(20)  NOT NULL,
  "latest_version" varchar(32)  NOT NULL,
  "public"         boolean      NOT NULL DEFAULT true,
  "downloads"      integer      NOT NULL DEFAULT 0,
  "created_at"     timestamptz  NOT NULL DEFAULT now(),
  "updated_at"     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_skill_package" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_package_slug" ON "skill_package" ("slug");
CREATE INDEX IF NOT EXISTS "idx_skill_package_public_downloads" ON "skill_package" ("public", "downloads" DESC);

CREATE TABLE IF NOT EXISTS "skill_version" (
  "id"          varchar(20)  NOT NULL,
  "package_id"  varchar(20)  NOT NULL,
  "version"     varchar(32)  NOT NULL,
  "asset_key"   varchar(256) NOT NULL,
  "checksum"    varchar(64)  NOT NULL,
  "size_bytes"  integer      NOT NULL,
  "readme"      text         NOT NULL,
  "changelog"   text,
  "created_at"  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_skill_version" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_version_pkg_ver" ON "skill_version" ("package_id", "version");
```

- [ ] **Step 2: 实体**（继承 SnowflakeBaseEntity，仿 app-user.entity.ts）

`libs/main/src/entities/skill-package.entity.ts`：
```ts
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index, UpdateDateColumn } from "typeorm";

/** 技能市场包(元数据)。内容在 skill_version 指向 minio。 */
@Entity("skill_package")
@Index("idx_skill_package_slug", ["slug"], { unique: true })
export class SkillPackage extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 64 }) slug!: string;
  @Column({ type: "varchar", length: 128 }) displayName!: string;
  @Column({ type: "text" }) description!: string;
  @Column({ type: "varchar", length: 20 }) authorUserId!: string;
  @Column({ type: "varchar", length: 32 }) latestVersion!: string;
  @Column({ type: "boolean", default: true }) public!: boolean;
  @Column({ type: "int", default: 0 }) downloads!: number;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
  @UpdateDateColumn({ type: "timestamptz" }) updatedAt!: Date;
}
```
`libs/main/src/entities/skill-version.entity.ts`：
```ts
import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 技能某版本。asset_key 指向 minio 对象。 */
@Entity("skill_version")
@Index("idx_skill_version_pkg_ver", ["packageId", "version"], { unique: true })
export class SkillVersion extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 20 }) packageId!: string;
  @Column({ type: "varchar", length: 32 }) version!: string;
  @Column({ type: "varchar", length: 256 }) assetKey!: string;
  @Column({ type: "varchar", length: 64 }) checksum!: string;
  @Column({ type: "int" }) sizeBytes!: number;
  @Column({ type: "text" }) readme!: string;
  @Column({ type: "text", nullable: true }) changelog!: string | null;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
}
```

- [ ] **Step 3: 对外类型 + DTO + 导出**

写 `libs/types-main/src/skill.ts`(上方 Produces 全文)；`libs/types-main/src/index.ts` 加 `export * from "./skill";`。
`libs/main/src/dto/skill.dto.ts`：
```ts
import { createZodDto } from "nestjs-zod";
import { PublishSkillSchema } from "@meshbot/types-main";

/** POST /api/skills 入参。 */
export class PublishSkillDto extends createZodDto(PublishSkillSchema) {}
```

- [ ] **Step 4: typecheck + 提交**

Run: `pnpm --filter @meshbot/types-main --filter @meshbot/main typecheck` → Done。
```bash
git add apps/server-main/migrations libs/main/src/entities libs/types-main/src libs/main/src/dto
git commit -m "feat(skill-market): DDL + SkillPackage/SkillVersion 实体 + 对外类型/DTO

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: SkillPackageService + SkillMarketService（DB + 对象存储）

**Files:** Create `skill-package.service.ts` / `skill-market.service.ts` + 各 `.spec.ts`；Modify `main.module.ts`、`libs/main/src/index.ts`、`libs/assets/src/assets.module.ts`(global)。

**Interfaces:**
- Consumes: `SkillPackage`/`SkillVersion`(Task1)、`AssetService`(3a)、类型(Task1)。
- Produces:
  ```ts
  class SkillPackageService {
    list(q?: string): Promise<SkillPackage[]>;            // public=true，downloads desc
    getBySlug(slug: string): Promise<SkillPackage | null>;
    listVersions(packageId: string): Promise<SkillVersion[]>;  // createdAt desc
    getVersion(packageId: string, version: string): Promise<SkillVersion | null>;
    incrementDownloads(packageId: string): Promise<void>;
    /** @Transactional 跨两表：upsert 包 + 插版本 + 更新 latest_version。 */
    persistPublish(authorUserId, input, assetKey, checksum, sizeBytes): Promise<void>;
  }
  class SkillMarketService {
    list(q?): Promise<MarketSkillSummary[]>;
    detail(slug): Promise<MarketSkillDetail | null>;
    download(slug, version?): Promise<{ stream: NodeJS.ReadableStream; filename: string } | null>;
    publish(authorUserId, input: PublishSkillInput): Promise<void>;
  }
  ```

- [ ] **Step 1: AssetsModule 设 global**

Modify `libs/assets/src/assets.module.ts` 的 forRoot 返回对象加 `global: true`：
```ts
    return {
      module: AssetsModule,
      global: true,
      providers: [ ... ],
      exports: [AssetService],
    };
```
跑 `pnpm test -- --roots libs/assets`(11 例仍绿，global 不影响测试)。

- [ ] **Step 2: SkillPackageService（写失败单测 → 实现）**

单测仿 `libs/main/src/services/org.service.spec.ts` 的 DataSource 搭建(读它复制内存/测试 DB harness)。覆盖：list 仅 public 且按 downloads desc；getBySlug 命中/未命中；getVersion；incrementDownloads +1；persistPublish 新包(建 package+version,latestVersion=ver)与既有包(加版本+更新 latestVersion)。
实现 `skill-package.service.ts`：`@InjectRepository(SkillPackage)`+`@InjectRepository(SkillVersion)`(经 TxTypeOrmModule.forFeature 提供)。`persistPublish` 挂 `@Transactional()`(跨两表)；upsert 用 `repo.findOneBy({slug})` 决定建/更，版本用 `create()+save()`(雪花 @BeforeInsert，勿用 .insert/plain upsert——见 snowflake-beforeinsert 坑)。

- [ ] **Step 3: SkillMarketService（写失败单测 → 实现）**

单测：mock SkillPackageService + AssetService(jest.fn)；
- list → 映射为 MarketSkillSummary(author 暂用 authorUserId，后续可 join 用户名)；
- detail → 包 + versions + 最新版本 readme;未命中返 null；
- download(slug,version?) → 取版本(缺省 latestVersion)→ asset.getStream(assetKey) + incrementDownloads + filename `<slug>-<version>.tar.gz`;
- publish → base64 解 tarball Buffer → 算 sha256 → assetKey=`skills/<slug>/<version>.tar.gz` → asset.put(key,buf,"application/gzip") → packageService.persistPublish(...);**同 slug 非作者** → 抛 AppError(FORBIDDEN)。
实现 `skill-market.service.ts`(注入 SkillPackageService + AssetService)。

- [ ] **Step 4: 注册 + 导出 + 校验 + 提交**

`main.module.ts`：forFeature 加 `SkillPackage, SkillVersion`；providers 加 `SkillPackageService, SkillMarketService`；exports 加 `SkillMarketService`(+ SkillPackageService 若 controller 直用)。
`libs/main/src/index.ts`：导出 `SkillMarketService`、`PublishSkillDto`。
Run：`pnpm test -- --roots libs/main`(含新单测全绿) + `pnpm --filter @meshbot/main --filter @meshbot/assets typecheck` + `pnpm check`。提交(中文 message + 尾)。

---

### Task 3: 配置接线 + SkillController + e2e

**Files:** Modify `app-config.schema.ts`、`app.module.ts`；Create `skill.controller.ts`、`test/e2e/skill-flow.spec.ts`。

- [ ] **Step 1: 配置 assets 切片**

`app-config.schema.ts` 加(仿现有切片):
```ts
assets: z.object({
  minio: z.object({
    endPoint: z.string(), port: z.coerce.number().default(9000),
    useSSL: z.coerce.boolean().default(false),
    accessKey: z.string(), secretKey: z.string(),
    bucket: z.string().default("meshbot-skills"),
  }),
}),
```
(YAML/Nacos 配置补对应字段;dev 本地 minio 默认值见 schema。)

- [ ] **Step 2: 接 AssetsModule + 注册 Controller**

`app.module.ts`：import `AssetsModule` from `@meshbot/assets`；imports 加 `AssetsModule.forRoot({ provider: "minio", minio: config.assets.minio })`；controllers 加 `SkillController`。

- [ ] **Step 3: SkillController**

`apps/server-main/src/rest/skill.controller.ts`(仿 org.controller；list/detail/download 加 `@Public()`，publish 走全局 JWT + `@CurrentUser`):
```ts
@Controller("skills")
export class SkillController {
  constructor(private readonly market: SkillMarketService) {}

  @Public() @Get()
  list(@Query("q") q?: string): Promise<MarketSkillSummary[]> { return this.market.list(q); }

  @Public() @Get(":slug")
  async detail(@Param("slug") slug: string): Promise<MarketSkillDetail> {
    const d = await this.market.detail(slug);
    if (!d) throw new NotFoundException();
    return d;
  }

  @Public() @Get(":slug/:version/download")
  async download(@Param("slug") slug: string, @Param("version") version: string,
    @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const r = await this.market.download(slug, version);
    if (!r) throw new NotFoundException();
    res.set({ "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${r.filename}"` });
    return new StreamableFile(r.stream);
  }

  @Post()
  publish(@CurrentUser() user: JwtMainPayload, @Body() dto: PublishSkillDto): Promise<void> {
    return this.market.publish(user.userId, dto);
  }
}
```
(`@Public`/`CurrentUser`/`JwtMainPayload` 从 server-main auth 引；`StreamableFile`/`Res` 从 @nestjs/common + express。)

- [ ] **Step 4: e2e**

`test/e2e/skill-flow.spec.ts`(仿 org-flow.spec.ts 搭建,但用 `.overrideProvider(AssetService).useValue(<内存假实现:Map put/getStream/...>)` 免真实 minio):
- 注册+登录拿 token → POST /api/skills 发布(base64 一个小 tar.gz)→ 200;
- GET /api/skills 含该 slug;GET /api/skills/:slug 返 detail(readme/versions);GET /api/skills/:slug/:version/download 返 gzip 流(下载数+1);
- 另一用户 POST 同 slug 新版本 → 403。

- [ ] **Step 5: 校验 + 提交**

`pnpm --filter @meshbot/server-main typecheck` + `pnpm check` + e2e 跑通(本地 Postgres + 假 AssetService)。提交。

## Self-Review
- **Spec 覆盖**：3b = DDL+Entity+Service+Controller(list/detail/download/publish)+types-main+e2e+用 libs/assets → Task1(DDL/实体/类型/DTO)+Task2(两 Service+global assets)+Task3(配置/Controller/e2e) 全覆盖。
- **占位符**：DDL/实体/类型/DTO/Controller 给全代码；Service 方法签名+行为+依赖明确,单测 harness 指向既有 org.service.spec/org-flow.spec 复制(DRY,不重抄 harness)。
- **类型一致**：MarketSkillSummary/Detail/PublishSkillInput 在 types-main 定义,Service 返回/Controller 签名一致;实体列与 DDL 列一一对应(id/外键 varchar(20))。
- **约定**：实体继承 SnowflakeBaseEntity(check:pk);persistPublish 跨两表挂 @Transactional 命名 persist*(check:naming);雪花 save 用 create()+save();AssetsModule global 解决 libs/main 注入 AssetService。
