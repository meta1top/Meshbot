# SP2：对话式技能管理工具 + 归档格式统一为 ZIP 设计

## 背景

技能市场原始需求第 1 点的最后一块:**对话式技能管理**——用户对话即可装/卸/搜/发布技能。前置发现 clawhub 下载端点返 **ZIP**(github/ourMarket 当前是 tar.gz),决定**全链路统一为 ZIP**(更干净、clawhub 原生、github 也能出 zip、市场无历史数据可直接切)。

本设计含两部分:
- **Part 1**:归档格式统一为 ZIP(改 3b server-main + 3c server-agent archive/sources + 3d web)。
- **Part 2**:对话式工具(端口范式,镜像 SCHEDULE_TOOLS_PORT)。

## Part 1：归档格式统一为 ZIP

### 1.1 skill-archive 重写为 zip（apps/server-agent/src/skills/skill-archive.ts）
- 用 **fflate**(零依赖、自带 TS 类型、内存 `zipSync`/`unzipSync`)替换 node-tar。新增 server-agent 依赖 `fflate`。
- `packDir(dir): Promise<Buffer>`:递归读目录 → `zipSync` → Buffer(zip)。
- `extractToDir(zip: Buffer, destDir): Promise<void>`:`unzipSync` → 逐 entry **校验路径穿越**(`path.resolve(destDir, name)` 必须以 `destDir + sep` 开头,否则抛 `AppError(SKILL_UNSAFE_ARCHIVE)`)→ 通过后清空/建 destDir 并写文件(沿用 3c「先验后写」两遍法语义)。
- `findSkillRoot(zip: Buffer): Promise<string | null>`:`unzipSync` 的 entry 名里找含 `SKILL.md` 的(子)目录前缀;无则 null。
- **路径穿越防护单测必须保留并适配 zip**:`../evil`、绝对路径 entry 被拒且不越界写。

### 1.2 SkillSourceAdapter 契约（apps/server-agent/src/skills/sources/skill-source.ts）
- `fetchPackage(ref, version?)` 返回类型由 `{ tarGz: Buffer; suggestedName }` 改为 `{ archive: Buffer; suggestedName }`(archive = zip 字节)。全部源与 SkillInstallService 同步改名。

### 1.3 三源
- **GithubSource**:下载 URL `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>` → `.../zip/<ref>`。github zip 顶层仍是 `<repo>-<ref>/`,由 findSkillRoot 处理。
- **ClawhubSource**:实现 `fetchPackage(slug, version?)` = `GET https://clawhub.ai/api/v1/download?slug=<slug>[&version=<version>]` → arrayBuffer → Buffer(zip);`suggestedName = slug`。**删除原 `SKILL_SOURCE_UNSUPPORTED` 抛错**。list 仍 `GET /api/v1/skills`(或 `/api/v1/search?q=` 当有 query)。
- **OurMarketSource**:下载得到的二进制现在是 zip,逻辑不变(仍直接 fetch + Bearer token 取 arrayBuffer)。

### 1.4 server-main（3b）
- `SkillMarketService.publish`:asset key `skills/<slug>/<version>.tar.gz` → `.zip`;`asset.put` content-type `application/gzip` → `application/zip`。sha256/流程不变。
- `SkillController.download`:`Content-Type` → `application/zip`;filename `<slug>-<ver>.tar.gz` → `.zip`。
- `libs/types-main` `PublishSkillSchema`:字段 `tarballBase64` → `archiveBase64`(zip 的 base64)。`SkillMarketService.publish` 入参随之改名。
- DDL/entity `asset_key` 列**不变**(仅存的值扩展名变),无需新 DDL。
- 受影响测试:`skill-market.service.spec`(tar/gzip 断言 → zip)、e2e `skill-flow.spec.ts`(`gzipSync`→zip 构造、content-type 断言 `gzip`→`zip`、字段名)。

### 1.5 server-agent publish 链路
- `SkillInstallService.publish`:`packDir` 现出 zip → 构造 server-main body 用 `archiveBase64`(zip base64)。

### 1.6 web（3d）
- `/skills` clawhub:**重新启用安装**——`market-skill-card` clawhub 不再 `disabled`,移除「暂不支持安装」横幅/提示。

## Part 2：对话式技能管理工具（端口范式）

### 2.1 端口（libs/agent/src/tools/skill-tools.port.ts）
镜像 `schedule-tools.port.ts`:
```ts
export const SKILL_TOOLS_PORT = Symbol("SKILL_TOOLS_PORT");
export interface InstalledSkillView {
  name: string; description: string;
  source: string | null; ref: string | null; version: string | null;
}
export interface MarketSkillView {
  source: string; slug: string; displayName: string;
  description: string; author: string; latestVersion: string;
}
export interface SkillToolsPort {
  install(input: { source: "ourMarket" | "github" | "clawhub"; ref: string; version?: string }): Promise<InstalledSkillView>;
  uninstall(name: string): Promise<void>;
  searchMarket(source: "ourMarket" | "github" | "clawhub", query?: string): Promise<MarketSkillView[]>;
  publish(input: { name: string; slug: string; displayName: string; version: string; changelog?: string }): Promise<void>;
}
```

### 2.2 四个工具（libs/agent/src/tools/builtins/）
`@Tool()` + `@Injectable` + `@Inject(SKILL_TOOLS_PORT)`,各自 Zod schema + 中文 description + execute 委托端口、结果 JSON.stringify 给 LLM:
- `skill_install`(args: source/ref/version?)
- `skill_uninstall`(args: name)
- `skill_search_market`(args: source/query?)
- `skill_publish`(args: name/slug/displayName/version/changelog?)
注册进 `libs/agent/src/agent.module.ts` providers。

### 2.3 端口绑定（apps/server-agent/src/skill.module.ts）
- 模块改 `@Global()`(让 AgentModule 内 4 个 tool 解析 SKILL_TOOLS_PORT,同 CronJobModule 范式)。
- `useFactory` 提供 `SKILL_TOOLS_PORT`,委托 `SkillInstallService`(install/uninstall/market/publish);`exports` 加 SKILL_TOOLS_PORT。

## 数据流 / 热加载 / 安全

- 工具在 LangGraph run 内执行,**账号上下文 ALS 可用** → 端口委托的 SkillInstallService 用账号化 skills 目录 + 账号 token(同 schedule 工具)。
- 装/卸后 `skill_list` 每次重扫磁盘 → **天然热**,agent 装完即可 `skill_load` 使用,无需 reload。
- install 解 zip 走防穿越 `extractToDir`;uninstall 仅删账号 skills 目录内。
- publish 经工具触发把本地技能上传云端市场(用户对话授权)。

## 测试

- `skill-archive.spec`(zip):extract/pack/findSkillRoot 往返、**路径穿越 + 绝对路径被拒**。
- `clawhub.source.spec`:`fetchPackage` mock fetch 返 zip → 得 archive Buffer;list/search 映射。
- `github.source.spec`:URL 改 `/zip/`。
- 4 个 tool 单测:假端口,断言 args 校验 + 调端口 + 结果序列化(仿 `schedule-tools.spec.ts`)。
- server-main:`skill-market.service.spec` + e2e `skill-flow.spec` 改 zip。
- 收尾:`pnpm check`(error-code GAP=0;check:dead) + 全包 typecheck + 受影响 jest。

## 非目标

- 不保留 tar.gz 兼容(市场无历史数据,直接切 zip)。
- 不做技能版本升级/更新检测(后续)。
- clawhub publish 仍走我们自己的市场(不向 clawhub 上传)。

## 实施顺序建议

Part 1 先行(格式统一是 Part 2 工具的基座),Part 2 在其上加工具。
