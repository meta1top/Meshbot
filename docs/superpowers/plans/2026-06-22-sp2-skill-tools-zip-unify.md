# SP2：对话式技能工具 + 归档统一 ZIP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development 或 inline executing-plans。Steps 用 `- [ ]`。

**Goal:** 全链路归档统一为 ZIP(含 clawhub 安装),并给 agent 加 4 个对话式技能管理工具(install/uninstall/search_market/publish)。

**Architecture:** Part 1 把 skill-archive 从 tar 改 fflate-zip、三源出 zip、server-main 存/发 zip;Part 2 端口范式(SKILL_TOOLS_PORT,镜像 SCHEDULE_TOOLS_PORT)在 libs/agent 加工具、server-agent @Global 绑 SkillInstallService。

**Tech Stack:** fflate(新依赖,内存 zipSync/unzipSync,自带类型)、NestJS、Node 原生 fetch、@langchain tools、root Jest。

## Global Constraints
- 路径穿越防护**必须保留**(zip 解包逐 entry 校验落在 destDir 内,否则 `AppError(AgentErrorCode.SKILL_UNSAFE_ARCHIVE)`)。
- 不保留 tar.gz 兼容(市场无历史数据,直接切 zip)。
- check:error-code GAP=0;check:dead 无悬挂;全包 typecheck;受影响 jest 全绿(server-agent 仅 1 个预存在 session.e2e 失败属基线)。
- 提交中文 conventional + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 尾;别 --no-verify。每任务后 `pnpm exec biome check --write <改动目录>`。

---

## Part 1：归档格式统一为 ZIP

### Task 1: skill-archive 改 fflate-zip（TDD，安全核心）

**Files:** Modify `apps/server-agent/src/skills/skill-archive.ts` + `.spec.ts`;`apps/server-agent/package.json`(加 `fflate`)。

**Interfaces — Produces:**(签名不变,语义 tar→zip)
```ts
export async function packDir(dir: string): Promise<Buffer>;           // zip
export async function extractToDir(zip: Buffer, destDir: string): Promise<void>;
export async function findSkillRoot(zip: Buffer): Promise<string | null>;
```

- [ ] **Step 1:** 加依赖 `pnpm --filter @meshbot/server-agent add fflate`。
- [ ] **Step 2:** 改 `.spec.ts`:构造 zip(用 fflate `zipSync` 或 packDir)替代 tar 构造;保留全部安全用例:正常解出含 SKILL.md;`../evil` entry 被拒(SKILL_UNSAFE_ARCHIVE)且 destDir 外无文件;绝对路径 entry 拒;findSkillRoot(根/单层子目录/无);packDir→extractToDir 往返一致。运行确认(旧 tar 实现下)失败。
- [ ] **Step 3:** 重写 `skill-archive.ts`(全文):
```ts
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@meshbot/common";
import { unzipSync, zipSync } from "fflate";
import { AgentErrorCode } from "../errors/agent.error-codes";

/** 递归收集目录文件为 {相对路径: 内容}。 */
async function collectFiles(
  root: string,
  rel = "",
  acc: Record<string, Uint8Array> = {},
): Promise<Record<string, Uint8Array>> {
  const dir = path.join(root, rel);
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) await collectFiles(root, childRel, acc);
    else if (ent.isFile()) acc[childRel] = await readFile(path.join(root, childRel));
  }
  return acc;
}

/** 将目录内容打包成 zip Buffer（用于发布技能）。 */
export async function packDir(dir: string): Promise<Buffer> {
  const files = await collectFiles(dir);
  return Buffer.from(zipSync(files));
}

/**
 * 安全解包 zip 到目标目录。
 * 安全约束：每个 entry 解析路径必须以 destDir+sep 开头，否则抛 SKILL_UNSAFE_ARCHIVE
 * （路径穿越 / 绝对路径均被拒）。先全量校验，通过后再清空 destDir 并写文件。
 */
export async function extractToDir(zip: Buffer, destDir: string): Promise<void> {
  const resolvedDest = path.resolve(destDir);
  const prefix = resolvedDest + path.sep;
  const entries = unzipSync(zip);

  // 第一遍：校验所有路径，逃逸即抛（未写任何文件）
  for (const name of Object.keys(entries)) {
    if (!name || name.endsWith("/")) continue; // 目录条目跳过
    const resolved = path.resolve(resolvedDest, name);
    if (resolved !== resolvedDest && !resolved.startsWith(prefix)) {
      throw new AppError(AgentErrorCode.SKILL_UNSAFE_ARCHIVE);
    }
  }

  // 通过后：清空重建并写文件
  await rm(resolvedDest, { recursive: true, force: true });
  await mkdir(resolvedDest, { recursive: true });
  for (const [name, data] of Object.entries(entries)) {
    if (!name || name.endsWith("/")) continue;
    const target = path.resolve(resolvedDest, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

/**
 * 在 zip 中查找含 SKILL.md 的目录。
 * - 根 → "."；单层子目录（如 repo-main/SKILL.md）→ 子目录名；无 → null
 */
export async function findSkillRoot(zip: Buffer): Promise<string | null> {
  const names = Object.keys(unzipSync(zip));
  const skillMd = names.filter((p) => path.basename(p) === "SKILL.md");
  for (const entry of skillMd) {
    const dir = path.dirname(entry);
    if (dir === "." || dir === "") return ".";
    const parts = dir.split("/").filter(Boolean);
    if (parts.length === 1) return parts[0];
  }
  return null;
}
```
> 注:fflate `unzipSync` 解全部到内存(技能包小,可接受)。Buffer 即 Uint8Array,直接互通。
- [ ] **Step 4:** `pnpm test -- --roots apps/server-agent --testPathPatterns skill-archive` 全绿;typecheck;biome;提交。

### Task 2: 三源 + SkillInstallService 改 zip

**Files:** Modify `sources/skill-source.ts`、`sources/github.source.ts`、`sources/clawhub.source.ts`、`skills/skill-install.service.ts`;相关 `.spec.ts`。

**Interfaces — Consumes:** Task1 的 archive 函数。**Produces:** `SkillPackage { archive: Buffer; suggestedName }`。

- [ ] **Step 1:** `skill-source.ts`:`SkillPackage.tarGz` → `archive`;注释 tar.gz→zip。
- [ ] **Step 2:** `github.source.ts`:下载 URL `/tar.gz/<ref>` → `/zip/<ref>`;返回 `{ archive, suggestedName }`。`.spec` 断言 URL 含 `/zip/`。
- [ ] **Step 3:** `clawhub.source.ts`:实现 `fetchPackage(slug, version?)`:
```ts
async fetchPackage(ref: string, version?: string): Promise<SkillPackage> {
  const url = new URL("https://clawhub.ai/api/v1/download");
  url.searchParams.set("slug", ref);
  if (version) url.searchParams.set("version", version);
  const res = await fetch(url);
  if (!res.ok) throw new AppError(AgentErrorCode.SKILL_INSTALL_FAILED);
  const archive = Buffer.from(await res.arrayBuffer());
  return { archive, suggestedName: ref };
}
```
删除原 `SKILL_SOURCE_UNSUPPORTED` 抛错;`list(q)`:有 q 走 `GET /api/v1/search?q=`,否则 `/api/v1/skills`(按现有映射范式)。`.spec` 加 fetchPackage 返 zip 用例。
- [ ] **Step 4:** `skill-install.service.ts`:`pkg.tarGz` → `pkg.archive`(install 内 findSkillRoot/extractToDir 调用处);publish 内 `const archive = await packDir(skillDir); const archiveBase64 = archive.toString("base64");` 并把 POST body 字段 `tarballBase64` → `archiveBase64`。`.spec` 同步。
- [ ] **Step 5:** `pnpm test -- --roots apps/server-agent`(archive/source/install 绿,余 1 预存在 e2e) + typecheck + biome + 提交。

### Task 3: server-main 存/发 zip

**Files:** Modify `libs/types-main/src/skill.ts`(PublishSkillSchema)、`libs/main/src/services/skill-market.service.ts`、`apps/server-main/src/rest/skill.controller.ts`;`skill-market.service.spec`、`apps/server-main/test/e2e/skill-flow.spec.ts`。

- [ ] **Step 1:** `types-main/skill.ts`:`PublishSkillSchema` 字段 `tarballBase64` → `archiveBase64`(描述改 zip)。
- [ ] **Step 2:** `skill-market.service.ts` `publish`:入参解 `archiveBase64`;asset key `skills/<slug>/<version>.tar.gz` → `.zip`;`asset.put(..., "application/zip")`。
- [ ] **Step 3:** `skill.controller.ts` `download`:`Content-Type` `application/gzip`→`application/zip`;filename `.tar.gz`→`.zip`。
- [ ] **Step 4:** `skill-market.service.spec`:tar/gzip 相关断言/构造 → zip(可用 fflate `zipSync` 或任意字节,服务不校验格式,仅 content-type/key 断言)。`skill-flow.spec.ts`:`gzipSync`→`zipSync`(或 fflate)、body 字段 `tarballBase64`→`archiveBase64`、下载 content-type 断言 `gzip`→`zip`、filename。
- [ ] **Step 5:** `pnpm --filter @meshbot/server-main --filter @meshbot/types-main typecheck` + `pnpm test -- --roots libs/main`(+ 有 Postgres 时 skill-flow e2e)+ `pnpm check` + biome + 提交。

### Task 4: web /skills 重新启用 clawhub 安装

**Files:** Modify `apps/web-agent/src/components/skills/market-skill-card.tsx`、`apps/web-agent/src/app/skills/page.tsx`;`messages/*`(清理「暂不支持」文案)。

- [ ] **Step 1:** `market-skill-card.tsx`:移除 clawhub 专属 `disabled` 逻辑(安装按钮对 clawhub 正常可用)。
- [ ] **Step 2:** `page.tsx`:clawhub 视图移除「暂不支持安装」横幅/提示;clawhub 卡 `disabled` 传参去掉。
- [ ] **Step 3:** `messages/zh.json`+`en.json`:移除不再用的 clawhub 不支持文案键(check 无悬挂)。`pnpm sync:locales --write`。
- [ ] **Step 4:** `pnpm --filter @meshbot/web-agent typecheck` + `pnpm test -- --roots apps/web-agent` + biome + 提交。

---

## Part 2：对话式技能管理工具

### Task 5: SKILL_TOOLS_PORT + 4 工具 + agent.module 注册

**Files:** Create `libs/agent/src/tools/skill-tools.port.ts`、`libs/agent/src/tools/builtins/skill-install.tool.ts`、`skill-uninstall.tool.ts`、`skill-search-market.tool.ts`、`skill-publish.tool.ts`(+ `.spec.ts`);Modify `libs/agent/src/agent.module.ts`。

**Interfaces — Produces:**(端口,见 spec 2.1)
```ts
// skill-tools.port.ts
export const SKILL_TOOLS_PORT = Symbol("SKILL_TOOLS_PORT");
export interface InstalledSkillView { name: string; description: string; source: string | null; ref: string | null; version: string | null; }
export interface MarketSkillView { source: string; slug: string; displayName: string; description: string; author: string; latestVersion: string; }
export interface SkillToolsPort {
  install(input: { source: "ourMarket" | "github" | "clawhub"; ref: string; version?: string }): Promise<InstalledSkillView>;
  uninstall(name: string): Promise<void>;
  searchMarket(source: "ourMarket" | "github" | "clawhub", query?: string): Promise<MarketSkillView[]>;
  publish(input: { name: string; slug: string; displayName: string; version: string; changelog?: string }): Promise<void>;
}
```

- [ ] **Step 1:** 写 `skill-tools.port.ts`(上方全文 + 中文 JSDoc,说明 libs/agent→server-agent 解耦边界,同 schedule-tools.port)。
- [ ] **Step 2:** 写 4 个 tool(`@Injectable @Tool`,implements `MeshbotTool<Args,string>`,`@Inject(SKILL_TOOLS_PORT)`,中文/英 description,execute 委托端口 + 结果 `JSON.stringify`)。`skill_install` 示例:
```ts
const ArgsSchema = z.object({
  source: z.enum(["ourMarket", "github", "clawhub"]),
  ref: z.string().min(1).describe("ourMarket/clawhub=slug；github=owner/repo[@ref]"),
  version: z.string().optional(),
});
type Args = z.input<typeof ArgsSchema>;
@Injectable()
@Tool()
export class SkillInstallTool implements MeshbotTool<Args, string> {
  readonly name = "skill_install";
  readonly description = "Install a skill from ourMarket / GitHub / clawhub into the local skills directory (hot-loaded). Returns the installed skill name + description.";
  readonly schema = ArgsSchema;
  constructor(@Inject(SKILL_TOOLS_PORT) private readonly port: SkillToolsPort) {}
  async execute(args: Args, _ctx: ToolContext): Promise<string> {
    const s = await this.port.install(args);
    return JSON.stringify(s);
  }
}
```
其余三个同构:`skill_uninstall`(args `{name}`→port.uninstall→`"Uninstalled <name>"`);`skill_search_market`(args `{source, query?}`→port.searchMarket→`JSON.stringify(list)`,description 注明 github 无检索返空);`skill_publish`(args `{name,slug,displayName,version,changelog?}`→port.publish→`"Published <slug>@<version>"`)。
- [ ] **Step 3:** `agent.module.ts`:import 4 个 tool,加入 `providers`(同 SkillListTool 位置)。
- [ ] **Step 4:** 4 个 `.spec.ts`:假 `SkillToolsPort`,断言 schema 解析 + 调端口 + 返回串(仿 `schedule-tools.spec.ts`)。`pnpm test -- --roots libs/agent --testPathPatterns skill`(注意 libs/agent 用 vitest,沿用其范式)。
- [ ] **Step 5:** `pnpm --filter @meshbot/agent typecheck` + 测试 + biome + 提交。

### Task 6: skill.module 绑定端口（@Global + useFactory）

**Files:** Modify `apps/server-agent/src/skill.module.ts`。

**Interfaces — Consumes:** Task5 `SKILL_TOOLS_PORT`;现有 `SkillInstallService`。

- [ ] **Step 1:** `skill.module.ts`:加 `@Global()`(同 CronJobModule,让 AgentModule 内 4 个 tool 解析端口);providers 加:
```ts
{
  provide: SKILL_TOOLS_PORT,
  useFactory: (svc: SkillInstallService) => ({
    install: (input) => svc.install(input),
    uninstall: (name: string) => svc.uninstall(name),
    searchMarket: (source, query) => svc.market(source, query),
    publish: (input) => svc.publish(input),
  }),
  inject: [SkillInstallService],
},
```
`exports` 加 `SKILL_TOOLS_PORT`。`SKILL_TOOLS_PORT` 从 `@meshbot/agent` import。
> 注:SkillInstallService.install 入参类型 = InstallSkillInput(source/ref/version);端口 install 入参形状一致,直接透传。市场搜索复用 `svc.market(source, q)`。
- [ ] **Step 2:** typecheck `@meshbot/server-agent`;**验证 DI/boot**:确认 AgentModule 4 个 tool 能解析 SKILL_TOOLS_PORT(同 schedule 工具靠 @Global 端口)。`pnpm test -- --roots apps/server-agent` + `pnpm check` + biome + 提交。

---

## Self-Review
- **Spec 覆盖**:Part1(zip 统一)= Task1(archive)+Task2(源/install)+Task3(server-main)+Task4(web clawhub 启用);Part2(工具)= Task5(端口+4工具)+Task6(绑定)。全覆盖。
- **占位符**:archive 全文、clawhub fetchPackage 全码、端口全码、install tool 全码、useFactory 全码;其余 3 工具按 install 同构(已给各自 args/返回);clawhub list/search 映射「按现有范式」(3c 已有 list 映射)。
- **类型一致**:SkillPackage.archive 全链一致;PublishSkillSchema.archiveBase64 在 types-main + server-agent publish + server-main publish 一致;SkillToolsPort 入参与 SkillInstallService(install/uninstall/market/publish)签名一致。
- **约定/安全**:zip 解包路径穿越防护(Task1 重点单测);端口范式镜像 schedule(@Global 绑定);check:dead(web 文案 + 旧 tar import)、error-code GAP=0。
- **风险**:libs/agent 用 vitest(工具测试沿用);clawhub list/search 响应字段以实际为准;市场无历史 tar.gz 数据故无需迁移。
