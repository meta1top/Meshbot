# SP3 云端技能市场 设计 (spec)

> 大功能「技能管理」拆为 SP0(更多重组+本地管理页)/SP1(本地安装运行时)/SP2(对话管理 tool)/SP3(云端市场)。本 spec 只覆盖 **SP3**,并把"下载安装必需的本地安装运行时"并入 SP3。SP0/SP1(独立部分)/SP2 另行成文。

**Goal:** 用户能在「技能」页浏览/搜索三类来源(我们的 server-main 市场 / clawhub.ai / GitHub 仓库)的技能,一键安装到本地、装后**热加载即用**,可卸载,并能把本地写的技能**上传发布**到我们的市场(官方+用户公开)。

**Architecture:** 三层 + 一个新存储库。
- `libs/assets`(新)：对象存储抽象,本期实现 minio,server-main 用它存技能包 tarball。
- `server-main`：技能市场(Postgres 元数据 + minio 内容),发布/检索/下载 API。
- `server-agent`：安装运行时——可插拔安装源(ourMarket/github/clawhub)+ 安装/卸载/发布 + 暴露 REST 给前端;装到 `accounts/<id>/skills/<name>/`,靠现有 `skill_list` 每次重扫天然热加载。
- `web-agent`：rail 加「技能」入口 + `/skills` 页(市场浏览 + 已安装管理),Slack 左对齐。

**Tech Stack:** NestJS(server-main/agent)、TypeORM、minio npm client、Next.js App Router + Jotai + next-intl + Tailwind v4、Zod(createZodDto)。clawhub API 见 https://docs.openclaw.ai/clawhub/(`GET /api/v1/skills` 等)。

## Global Constraints
- 仓库规约:Entity 唯一归属 Service 持 `@InjectRepository`;Controller 不直接注入 Repository;跨表写 `@Transactional`,单表不需要;账号作用域用 `ScopedRepository`(server-agent 侧若需)。
- server-main schema 走 **SQL DDL 文件**(`apps/server-main/migrations/<YYYYMMDDHHmm>-skill-marketplace.sql`,DBA 手动执行,幂等 `IF NOT EXISTS`,snake_case,逻辑外键,文件不可变)。改 Entity 必配 DDL(见 ddl-migration 技能)。
- 跨域 schema 放 `libs/types`;域内放 `libs/types-<domain>`;`libs/types-*` **禁止依赖 NestJS/TypeORM**;后端用 `createZodDto`。
- 技能内容单位:一个技能 = 目录 `<name>/`(含 `SKILL.md` + 可选附带文件),打包为 **tar.gz**。校验 sha256。
- 「已安装」真相 = 本地 `accounts/<id>/skills/` 目录(skill_list 重扫);每技能装时写 `.meshbot-install.json`(source/ref/version/installedAt),不在本地 DB 建表。
- minio 连接走 env(endpoint/accessKey/secretKey/bucket/useSSL);缺失时 server-main 启动告警但不崩(发布/下载在无 minio 时返明确错误)。
- 前端 Slack 风格、左对齐,配色 `--shell-*`;i18n 走 next-intl(新增嵌套 key 后 `sync:locales --write` 补扁平 stub,`missing=0 asymmetric=0`);无裸字符串。
- 提交中文 conventional;结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;commit 前 `pnpm check` + 受影响包 typecheck/lint。

## 数据模型

### server-main(DDL)
```sql
-- 技能包(市场条目)
CREATE TABLE IF NOT EXISTS "skill_package" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"            varchar(64)  NOT NULL,            -- 唯一标识(kebab-case，= 技能目录名)
  "display_name"    varchar(128) NOT NULL,
  "description"     text         NOT NULL,            -- 一行描述(来自 SKILL.md frontmatter)
  "author_user_id"  uuid         NOT NULL,            -- 发布者(逻辑外键 app_user.id)
  "latest_version"  varchar(32)  NOT NULL,
  "public"          boolean      NOT NULL DEFAULT true,
  "downloads"       integer      NOT NULL DEFAULT 0,
  "created_at"      timestamptz  NOT NULL DEFAULT now(),
  "updated_at"      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "uq_skill_package_slug" UNIQUE ("slug")
);

-- 技能版本(内容指向 minio 对象)
CREATE TABLE IF NOT EXISTS "skill_version" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "package_id"  uuid        NOT NULL,                 -- 逻辑外键 skill_package.id
  "version"     varchar(32) NOT NULL,
  "asset_key"   varchar(256) NOT NULL,               -- minio 对象键(tar.gz)
  "checksum"    varchar(64) NOT NULL,                -- sha256
  "size_bytes"  integer     NOT NULL,
  "changelog"   text,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_skill_version" UNIQUE ("package_id", "version")
);
CREATE INDEX IF NOT EXISTS "idx_skill_package_public_downloads"
  ON "skill_package" ("public", "downloads" DESC);
```
TypeORM Entity 同构(server-main `entities/`),归属 `SkillMarketService`。

### 本地安装清单(server-agent，文件)
`accounts/<cloudUserId>/skills/<name>/.meshbot-install.json`：
```jsonc
{ "source": "ourMarket" | "github" | "clawhub",
  "ref": "<slug|owner/repo@ref|clawhub-slug>",
  "version": "1.2.0",
  "installedAt": "ISO" }
```

## 共享类型(libs/types-agent/src/skill.ts，Zod)
- `SkillSource = "ourMarket" | "github" | "clawhub"`
- `MarketSkillSummary { source, ref, slug, displayName, description, author, latestVersion, downloads? }`
- `MarketSkillDetail extends summary { readme(SKILL.md 文本), versions: {version, changelog?, createdAt}[] }`
- `InstalledSkill { name, description, source, ref, version, installedAt, updateAvailable?: string|null }`
- `InstallSkillInput { source, ref, version? }`
- `PublishSkillInput { name }`(发布本地 skills/<name>)
- server-main 专用(作者/发布)放 `libs/types-main/src/skill.ts`。

## API

### server-main(`/api/skills`)
- `GET /api/skills?q=&sort=downloads&limit=&cursor=` → `MarketSkillSummary[]`(public，免鉴权浏览)。
- `GET /api/skills/:slug` → `MarketSkillDetail`(含 readme + 版本列表)。
- `GET /api/skills/:slug/:version/download` → tar.gz 流(经 libs/assets 读 minio；或 302 到签名 URL)。`downloads++`。
- `POST /api/skills`(JWT)multipart：tar.gz + `{slug, displayName, description, version, changelog?}` → 校验 sha256/解出 SKILL.md frontmatter 一致 → assets.put 到 minio → upsert skill_package + insert skill_version。同 slug 仅作者可发新版本。

### server-agent(`/api/skills`，给前端;全在账号上下文)
- `GET /api/skills/market?source=&q=` → 聚合 `MarketSkillSummary[]`(source=ourMarket 经 cloud client 调 main;clawhub 直连 clawhub.ai;github 不预列,靠 URL 直装)。
- `GET /api/skills/market/:source/:ref` → `MarketSkillDetail`。
- `GET /api/skills/installed` → `InstalledSkill[]`(扫 skills 目录 + 读 .meshbot-install.json + 与市场 latest 比对算 updateAvailable)。
- `POST /api/skills/install` `InstallSkillInput` → 取 tar.gz(按 source)→ 校验 → 解到 skills/<name>/(必含 SKILL.md,解析 frontmatter 取 name/description)→ 写 .meshbot-install.json → 返 InstalledSkill。**装后即热**(skill_list 下次重扫可见)。
- `DELETE /api/skills/:name` → rm -rf skills/<name>。
- `POST /api/skills/publish` `PublishSkillInput` → 打包本地 skills/<name> → POST 到 main `/api/skills`(带本地 JWT)。

## libs/assets(@meshbot/assets)
- NestJS 模块 `AssetsModule.forRoot(config)`;`AssetService` 接口:
  `put(key, body: Buffer, contentType): Promise<void>` / `get(key): Promise<Buffer>` / `getStream(key)` / `delete(key)` / `exists(key)` / `getSignedUrl(key, ttlSec): Promise<string>`。
- provider 抽象:本期 `MinioAssetProvider`(minio npm client);s3/oss 留接口(类型上预留,不实现)。
- 配置:`{ endpoint, port, useSSL, accessKey, secretKey, bucket }` 来自 env;启动确保 bucket 存在(makeBucket if not exists)。
- 依赖方向:`server-main → libs/assets → libs/common`(基础设施库,可依赖 NestJS,同 libs/common 性质)。

## 安装源适配器(server-agent)
统一接口 `SkillSourceAdapter { list(q): MarketSkillSummary[]; detail(ref): MarketSkillDetail; fetchPackage(ref, version?): { tarGz: Buffer; checksum?: string } }`。
- `OurMarketSource`:经 `CloudClientService` 调 server-main `/api/skills*`。
- `GithubSource`:`ref = owner/repo[@branch|tag]`;下载 `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>`,取仓库根或含 SKILL.md 的子目录。list 不支持(返空),靠 URL 直装。
- `ClawhubSource`:`https://clawhub.ai/api/v1/skills`(list/detail);下载端点按 docs.openclaw.ai/clawhub/ 文档确认(实现期拉文档)。
- 安装统一:解 tar.gz → 找到含 `SKILL.md` 的目录 → 拷到 `skills/<slug-or-name>/` → 解析 frontmatter 校验 name/description。

## web-agent UI
- rail 加「技能」nav(在「消息」下面;图标如 `Blocks`/`Puzzle`)。`areaFromPath` 增 `skills`(`/skills*`)。
- `/skills` 页 + 技能侧栏(Slack 段:`已安装` / `市场`(我们的/clawhub 切换;GitHub 用顶部 URL 输入直装))。
- 市场浏览:搜索框 + 技能卡(显示名/描述/作者/版本/装机数)+ 详情抽屉或页(SKILL.md 预览 + 版本 + 安装/已装态)。
- 已安装:列表 + 卸载 + 「有更新」标记 + 「上传到市场」入口(对本地技能)。
- 复用 `SidebarSection`/卡片范式;配色 `--shell-*`;响应式沿用本会话抽屉布局。
- REST 客户端 `rest/skills.ts` 调 server-agent `/api/skills*`;jotai atom 管市场/已装列表。

## 内部分期(逐期独立可验)
- **3a** `libs/assets`(minio)+ env 接线 + 单测(put/get/delete/exists 用本地 minio 或 mock)。
- **3b** server-main 市场:DDL + Entity + SkillMarketService + Controller(list/detail/download/publish)+ libs/types-main schema + e2e。
- **3c** server-agent 安装运行时:源适配器(ourMarket+github 先,clawhub 次)+ SkillInstallService + REST + types-agent schema + 单测(解包/校验/安装/卸载/清单)。
- **3d** web-agent:rail 入口 + /skills 页 + 市场/已装 UI + i18n。

## 验证
- server-main:e2e(发布→检索→下载往返;非作者发同 slug 被拒)。
- server-agent:单测(tar 解包安全[防路径穿越]、checksum、SKILL.md 校验、install/uninstall、installed 扫描+updateAvailable)。
- 端到端目检:UI 装一个技能 → 助手对话 `skill_list` 立刻能看到(热加载)→ 卸载后消失。
- `pnpm check` + typecheck/lint 全绿;DDL 幂等可重跑。

## Out of scope(SP3 不做)
- SP0「更多」重组 + 本地技能管理二级菜单(另文);SP2 对话管理 tool(skill_search/install/uninstall,依赖本 SP3 的安装运行时,另文)。
- 向 clawhub **发布**(本期只从 clawhub 浏览/安装)。
- s3/oss provider(仅 minio);技能评分/评论;org 私有技能(本期仅 public,Entity 留 `public` 列以后扩)。
- 技能携带 MCP/需 reloadRuntime 的情形(本期技能 = SKILL.md 纯文本指令)。

## 风险/待确认
- clawhub 下载端点 + 包格式:需查 docs.openclaw.ai/clawhub/(实现 3c 时确认;适配器隔离,不影响整体)。
- tar 解包必须防路径穿越(`../`)与符号链接逃逸——安全要点。
- 技能 slug 冲突(本地已存在同名)→ 安装时提示覆盖/改名。
