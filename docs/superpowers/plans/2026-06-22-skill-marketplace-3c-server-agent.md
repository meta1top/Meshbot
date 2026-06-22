# SP3-3c：server-agent 技能安装运行时（三源 + 装/卸/上传 + REST）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 `- [ ]`。

**Goal:** server-agent 能从「我们的市场(server-main)/GitHub 仓库/clawhub(浏览)」检索技能、安装到 `accounts/<id>/skills/<name>/`(天然热)、卸载、把本地技能打包上传发布;并暴露 REST 给前端(3d)与对话 tool(SP2)。

**Architecture:** 可插拔 `SkillSourceAdapter`(OurMarket 经 CloudClientService 调 server-main、Github 经 codeload tar.gz、Clawhub 经 clawhub.ai /api/v1/skills 仅浏览) → `SkillInstallService`(install/uninstall/publish/listInstalled,安全解 tar 到 skills 目录 + 写 `.meshbot-install.json` 清单) → `SkillController`(REST)。安装即热(现有 `skill_list` 每次重扫,无需 reloadRuntime)。

**Tech Stack:** NestJS、tar ^7(已装)、Node 原生 fetch、@meshbot/types-agent(Zod)、root Jest。CloudClientService(get/post/del + token)已存在;token 经 CloudIdentityService 按当前账号取(仿 `apps/server-agent/src/services/schedule.service.ts` 的取 token + cloud 调用)。

## Global Constraints
- 仅改 server-agent(+ libs/types-agent 加 schema)。安装目标目录 = `MeshbotConfigService.getSkillsDir()`(账号化,REST 在账号上下文内)。
- **tar 解包安全(关键)**:拒绝路径穿越——解包 entry 必须落在目标目录内(过滤含 `..`/绝对路径/符号链接逃逸的 entry);用 node-tar 的安全选项 + 自实现 onentry 校验。
- 每技能装时写 `accounts/<id>/skills/<name>/.meshbot-install.json` = `{source,ref,version,installedAt}`。已安装真相 = 扫 skills 目录(skill_list 已天然热)。
- clawhub 本期**仅浏览(list/detail)**;安装源仅 OurMarket + Github(clawhub 下载端点待查 docs.openclaw.ai,留 adapter 占位 + 明确不支持安装的报错)。
- REST 路由 `@Controller("api/skills")`(仿 cron-job.controller 的 "api/..." 全路径);account 上下文由全局机制提供。
- 错误码加到 `apps/server-agent/src/errors/agent.error-codes.ts`(defineErrorCode,紧接现有最大 code,check:error-code GAP=0):`SKILL_INSTALL_FAILED`/`SKILL_NOT_FOUND`/`SKILL_UNSAFE_ARCHIVE`/`SKILL_SOURCE_UNSUPPORTED`。
- 类型放 `libs/types-agent/src/skill.ts`(纯 Zod,复用 3b 的 MarketSkillSummary/Detail 形状,但本域独立定义,不依赖 types-main)。
- 中文 JSDoc;提交中文 conventional + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;每 Task 后 `pnpm check` + `pnpm --filter @meshbot/server-agent --filter @meshbot/types-agent typecheck` + 受影响 jest + biome。

## File Structure
- `libs/types-agent/src/skill.ts` + index 导出 — 安装相关类型。
- `apps/server-agent/src/skills/skill-archive.ts` + `.spec.ts` — 安全打包/解包工具(纯函数,重点单测)。
- `apps/server-agent/src/skills/sources/skill-source.ts` — `SkillSourceAdapter` 接口 + `SkillRef` 类型。
- `apps/server-agent/src/skills/sources/github.source.ts` — codeload 下载。
- `apps/server-agent/src/skills/sources/clawhub.source.ts` — clawhub.ai 浏览。
- `apps/server-agent/src/skills/sources/our-market.source.ts` — cloud client → server-main。
- `apps/server-agent/src/skills/skill-install.service.ts` + `.spec.ts` — 编排。
- `apps/server-agent/src/controllers/skill.controller.ts` — REST。
- `apps/server-agent/src/errors/agent.error-codes.ts`(改) — 错误码。
- 模块注册(`apps/server-agent/src/app.module.ts` 或对应 feature module) — providers + controller。

## 共享类型（libs/types-agent/src/skill.ts）
```ts
export type SkillInstallSource = "ourMarket" | "github" | "clawhub";
export const MarketSkillSummarySchema = z.object({
  source: z.enum(["ourMarket", "github", "clawhub"]),
  ref: z.string(), slug: z.string(), displayName: z.string(),
  description: z.string(), author: z.string(),
  latestVersion: z.string(), downloads: z.number().optional(),
});
export type MarketSkillSummary = z.infer<typeof MarketSkillSummarySchema>;
export const InstalledSkillSchema = z.object({
  name: z.string(), description: z.string(),
  source: z.enum(["ourMarket", "github", "clawhub"]).nullable(),
  ref: z.string().nullable(), version: z.string().nullable(),
  installedAt: z.string().nullable(),
});
export type InstalledSkill = z.infer<typeof InstalledSkillSchema>;
export const InstallSkillSchema = z.object({
  source: z.enum(["ourMarket", "github", "clawhub"]),
  ref: z.string().min(1),           // ourMarket=slug；github=owner/repo[@ref]；clawhub=slug
  version: z.string().optional(),
});
export type InstallSkillInput = z.infer<typeof InstallSkillSchema>;
export const PublishLocalSkillSchema = z.object({
  name: z.string().min(1),          // 本地 skills/<name>
  slug: z.string().min(1), displayName: z.string().min(1),
  version: z.string().min(1), changelog: z.string().optional(),
});
export type PublishLocalSkillInput = z.infer<typeof PublishLocalSkillSchema>;
```

---

### Task 1: 安全打包/解包工具 + 源适配器

**Files:** Create `skill-archive.ts`(+spec)、`sources/skill-source.ts`、`sources/github.source.ts`、`sources/clawhub.source.ts`、`sources/our-market.source.ts`；`libs/types-agent/src/skill.ts`(+index)。

**Interfaces — Produces:**
```ts
// skill-archive.ts
export async function packDir(dir: string): Promise<Buffer>;          // tar.gz 一个目录内容
export async function extractToDir(tarGz: Buffer, destDir: string): Promise<void>;
  // 安全解包：清空/创建 destDir，拒绝 entry 路径逃逸(抛 AppError SKILL_UNSAFE_ARCHIVE)
export async function findSkillRoot(tarGz: Buffer): Promise<string | null>;
  // 找含 SKILL.md 的(子)目录名;无则 null
// skill-source.ts
export interface SkillPackage { tarGz: Buffer; suggestedName: string; }
export interface SkillSourceAdapter {
  list(q?: string): Promise<MarketSkillSummary[]>;       // 不支持检索的源返 []
  fetchPackage(ref: string, version?: string): Promise<SkillPackage>;  // 不支持安装的源抛 SKILL_SOURCE_UNSUPPORTED
}
```

- [ ] **Step 1: 类型**
写 `libs/types-agent/src/skill.ts`(上方全文)；`libs/types-agent/src/index.ts` 加 `export * from "./skill";`(先看现有 index 范式)。typecheck `@meshbot/types-agent`。

- [ ] **Step 2: skill-archive 安全解包(TDD 重点)**
写 `skill-archive.spec.ts` 覆盖：
- `extractToDir` 正常解出含 SKILL.md 的包到 destDir；
- **含 `../evil` 的恶意 entry → 抛(SKILL_UNSAFE_ARCHIVE),且不在 destDir 外写文件**；
- 含绝对路径 entry → 拒绝；
- `findSkillRoot`:SKILL.md 在根/在单子目录 → 返对应路径;无 SKILL.md → null；
- `packDir` → `extractToDir` 往返：内容一致。
实现 `skill-archive.ts`：用 `tar.x`/`tar.c`(node-tar v7);extract 用 `onentry`/`filter` 校验 `path.resolve(destDir, entry.path)` 必须以 `destDir + sep` 开头,否则抛 `AppError(AgentErrorCode.SKILL_UNSAFE_ARCHIVE)`;另设 `preservePaths:false`。解包前 `rm -rf destDir` 再 `mkdir -p`。

- [ ] **Step 3: 源适配器**
- `github.source.ts`:`fetchPackage(ref)` 解析 `owner/repo[@gitref]`(默认 HEAD)→ `fetch("https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>")` → Buffer → `findSkillRoot`(github tar 顶层是 `<repo>-<ref>/`,技能可能在根或子目录)→ 返 {tarGz(裁剪到技能根?保留原包,解包时按 findSkillRoot 取子目录), suggestedName};`list` 返 [](GitHub 不预检索)。
- `clawhub.source.ts`:`list(q)` → `fetch("https://clawhub.ai/api/v1/skills")` → 映射为 MarketSkillSummary(source:"clawhub");`fetchPackage` 抛 `SKILL_SOURCE_UNSUPPORTED`(下载端点待 docs 确认,本期不支持装)。
- `our-market.source.ts`:注入 CloudClientService + 取 token(仿 schedule.service);`list(q)` → `cloud.get("/api/skills?q=",token)`;`fetchPackage(slug,version)` → `cloud.get("/api/skills/"+slug,token)` 取 latestVersion → `cloud.get("/api/skills/"+slug+"/"+ver+"/download",token)` 取 tar.gz(注意:download 是二进制流,CloudClientService 若只解 JSON 信封需加一个取原始 Buffer 的方法或直接 fetch 带 token——实现时按 CloudClientService 能力适配并在报告说明)。
单测:github ref 解析(owner/repo@tag);clawhub list 映射(mock fetch);our-market list(mock CloudClientService)。fetch 用 `jest.spyOn(global,"fetch")` mock。

- [ ] **Step 4: 错误码 + typecheck + 提交**
`agent.error-codes.ts` 加 `SKILL_INSTALL_FAILED/SKILL_NOT_FOUND/SKILL_UNSAFE_ARCHIVE/SKILL_SOURCE_UNSUPPORTED`(紧接现有最大 code)。`pnpm check`(error-code GAP=0) + typecheck + `pnpm test -- --roots apps/server-agent`(新 archive/source 单测绿)。提交。

---

### Task 2: SkillInstallService（install/uninstall/publish/listInstalled）

**Files:** Create `skill-install.service.ts`(+spec)。

**Interfaces — Produces:**
```ts
class SkillInstallService {
  market(source: SkillInstallSource, q?: string): Promise<MarketSkillSummary[]>;
  install(input: InstallSkillInput): Promise<InstalledSkill>;
  uninstall(name: string): Promise<void>;
  listInstalled(): Promise<InstalledSkill[]>;
  publish(input: PublishLocalSkillInput): Promise<void>;
}
```

- [ ] **Step 1: 写失败单测**
mock 三个 source adapter + AssetArchive(用真 skill-archive 或 mock)+ MeshbotConfigService.getSkillsDir(指向 tmp 目录)。覆盖：
- `install`:按 source 取 adapter → fetchPackage → extractToDir 到 `skillsDir/<name>`(name 来自 SKILL.md frontmatter 或 ref)→ 写 `.meshbot-install.json`(source/ref/version/installedAt)→ 返 InstalledSkill;校验解出含 SKILL.md(否则抛 SKILL_INSTALL_FAILED)。
- `uninstall`:删 `skillsDir/<name>`(不存在幂等)。
- `listInstalled`:扫 skillsDir 各子目录读 SKILL.md(name/description)+ `.meshbot-install.json`(source/ref/version)→ InstalledSkill[]。
- `publish`:`packDir(skillsDir/<name>)` → base64 → 构造 server-main publish body(slug/displayName/version/changelog/readme=SKILL.md 文本/tarballBase64)→ cloud.post("/api/skills",body,token)。

- [ ] **Step 2: 实现 + 校验 + 提交**
实现 `skill-install.service.ts`(注入三 source + CloudClientService + CloudIdentityService 取 token + MeshbotConfigService + 复用 skill-archive)。`pnpm test -- --roots apps/server-agent`(全绿)+ `pnpm check` + typecheck。提交。

---

### Task 3: SkillController（REST）+ 模块注册

**Files:** Create `controllers/skill.controller.ts`；Modify 模块(注册 providers:三 source + SkillInstallService;controllers:SkillController)。

- [ ] **Step 1: Controller**
`@Controller("api/skills")`(仿 cron-job.controller):
- `GET market?source=&q=` → `installService.market(source,q)`;
- `GET installed` → `listInstalled()`;
- `POST install`(body InstallSkillDto=createZodDto(InstallSkillSchema)) → `install()`;
- `DELETE :name` → `uninstall()`;
- `POST publish`(body PublishLocalSkillDto) → `publish()`。
DTO 用 `@meshbot/common` 的 `createZodDto`(本仓自有)。

- [ ] **Step 2: 注册 + 校验 + 提交**
在合适 module(看 cron-job/session 控制器在哪个 module 注册,照搬)加 providers(GithubSource/ClawhubSource/OurMarketSource/SkillInstallService)+ controllers(SkillController)。
`pnpm --filter @meshbot/server-agent typecheck` + `pnpm test -- --roots apps/server-agent` + `pnpm check`(围栏:check:repo——controller 不注入 Repository,SkillInstallService 不持 Repository,OK)。提交。

## Self-Review
- **Spec 覆盖**：3c = 安装源(ourMarket/github/clawhub)+ 装/卸/上传/已装列表 + REST + 安全解包 + 天然热 → Task1(类型/安全 archive/三源)+Task2(InstallService)+Task3(Controller)。clawhub 本期仅浏览(spec「clawhub 次」+ 下载端点未知,已在 constraints 标)。
- **占位符**：archive 安全/源/install/controller 行为与签名明确;cloud download 二进制取法标注「按 CloudClientService 能力适配」(实现期定,因需读其是否支持非 JSON 响应)。
- **类型一致**：MarketSkillSummary/InstalledSkill/InstallSkillInput/PublishLocalSkillInput 在 types-agent 定义,service/controller 一致。
- **约定/安全**：tar 路径穿越防护为重点单测;错误码 GAP=0;装到账号化 skillsDir,天然热;controller/service 不注入 Repository(check:repo)。
- **风险**：CloudClientService 可能只解 JSON 信封,二进制 download 需补取原始 Buffer 的能力或直接 fetch+token(Task1 Step3 标注);clawhub 安装下载端点待 docs。
