# SP3-3d：web-agent 技能页（rail 入口 + 市场浏览 + 已装管理）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 `- [ ]`。

**Goal:** web-agent 新增「技能」rail 入口与 `/skills` 页：浏览市场(我们的市场/GitHub/clawhub)并安装、管理已安装技能(卸载、上传到我们的市场),Slack 风格左对齐。

**Architecture:** 复用 3c 的 server-agent REST(`/api/skills/*`)。新增 `rest/skills.ts`(apiClient 封装)+ rail「技能」入口(areaFromPath 加 `skills`)+ `/skills` 页(AppShellLayout + 自定义 `SkillsSidebar` + 主区市场浏览/已装管理)。前端类型直接复用 `@meshbot/types-agent`(MarketSkillSummary/InstalledSkill/InstallSkillInput/PublishLocalSkillInput)。

**Tech Stack:** Next.js App Router、Jotai(本页用局部 useState,仿 schedule 页)、next-intl、Tailwind v4、lucide-react(`Blocks` 图标)、`@meshbot/web-common` 的 `apiClient`。

## Global Constraints
- 全简体中文文案;新增 t() 文案后跑 `pnpm --filter @meshbot/web-agent sync:locales --write` 补 stub(zh/en 都补,空扁平值正常)。
- UI Slack 风格、左对齐;复用现有组件范式:`SidebarSection`(可折叠分段,props: title/children/onAdd/addLabel/defaultOpen)、`cron-job-card`/`cron-job-form`(卡片 + 表单/对话框范式)、`messages-sidebar`(侧栏范式)。
- apiClient:`apiClient.get<T>(url,{params?})` / `.post<T>(url,body)` / `.delete<T>(url)`,均返 `{data:T}`(见 `apps/web-agent/src/rest/cron-jobs.ts`)。
- 前端测试现实:纯逻辑(areaFromPath)加 `lib/*.test.ts` 单测;组件经 `pnpm --filter @meshbot/web-agent typecheck` + biome 验证(本仓 web 无组件测试,不强加 RTL)。
- 每 Task 后:`pnpm --filter @meshbot/web-agent typecheck` + `pnpm test -- --roots apps/web-agent`(纯逻辑测试绿)+ `pnpm check` + `pnpm exec biome check --write apps/web-agent/src`。
- 提交中文 conventional + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 尾;别 --no-verify。

## File Structure
- `apps/web-agent/src/rest/skills.ts`(Create)— REST 封装(market/listInstalled/install/uninstall/publish)。
- `apps/web-agent/src/lib/area-from-path.ts`(Modify)+ `.test.ts`(Modify)— 加 `skills` 区域。
- `apps/web-agent/src/components/shell/workspace-rail.tsx`(Modify)— 加「技能」RailNavItem。
- `apps/web-agent/src/app/skills/page.tsx`(Create)— 技能页。
- `apps/web-agent/src/components/skills/skills-sidebar.tsx`(Create)— 侧栏(已安装段 + 市场源切换)。
- `apps/web-agent/src/components/skills/installed-skill-card.tsx`(Create)— 已装卡(卸载 + 上传)。
- `apps/web-agent/src/components/skills/publish-skill-dialog.tsx`(Create)— 上传到我们的市场对话框。
- `apps/web-agent/src/components/skills/market-skill-card.tsx`(Create)— 市场卡(安装)。
- `apps/web-agent/src/components/skills/install-from-github.tsx`(Create)— GitHub 安装输入。
- `apps/web-agent/messages/zh.json` + `en.json`(Modify)— 文案。

## REST 封装（rest/skills.ts，Task 1 全文）
```ts
"use client";
import type {
  InstallSkillInput, InstalledSkill, MarketSkillSummary,
  PublishLocalSkillInput, SkillInstallSource,
} from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/** 浏览指定源的技能市场(可选关键字)。 */
export async function fetchMarket(
  source: SkillInstallSource, q?: string,
): Promise<MarketSkillSummary[]> {
  const { data } = await apiClient.get<MarketSkillSummary[]>("/api/skills/market", {
    params: { source, ...(q ? { q } : {}) },
  });
  return data;
}
/** 已安装技能列表。 */
export async function fetchInstalled(): Promise<InstalledSkill[]> {
  const { data } = await apiClient.get<InstalledSkill[]>("/api/skills/installed");
  return data;
}
/** 安装技能。 */
export async function installSkill(input: InstallSkillInput): Promise<InstalledSkill> {
  const { data } = await apiClient.post<InstalledSkill>("/api/skills/install", input);
  return data;
}
/** 卸载技能。 */
export async function uninstallSkill(name: string): Promise<void> {
  await apiClient.delete<{ ok: true }>(`/api/skills/${encodeURIComponent(name)}`);
}
/** 上传本地技能到我们的市场。 */
export async function publishSkill(input: PublishLocalSkillInput): Promise<void> {
  await apiClient.post<void>("/api/skills/publish", input);
}
```
> 注:`apiClient.get` 的 params 形态以 `cron-jobs.ts` 的 `{params:{...}}` 为准;若实际签名不同(如 query string 拼接),按真实适配并报告。

---

### Task 1: 管道 — REST 封装 + rail 入口 + 最小技能页

**Files:** Create `rest/skills.ts`、`app/skills/page.tsx`(最小版);Modify `lib/area-from-path.ts`(+`.test.ts`)、`components/shell/workspace-rail.tsx`、`messages/zh.json`+`en.json`。

**Interfaces — Produces:** `fetchMarket/fetchInstalled/installSkill/uninstallSkill/publishSkill`(见上方全文);`ShellArea` 增 `"skills"`。

- [ ] **Step 1: areaFromPath 加 skills(先写失败测试)**
`lib/area-from-path.test.ts` 加用例:`expect(areaFromPath("/skills")).toBe("skills")`、`/skills/foo` → `"skills"`。运行确认失败。
- [ ] **Step 2: 实现 areaFromPath**
`lib/area-from-path.ts`:`ShellArea` 联合加 `"skills"`;在 `more` 判断前加 `if (pathname.startsWith("/skills")) return "skills";`。运行测试转绿(`pnpm test -- --roots apps/web-agent --testPathPatterns area-from-path`)。
- [ ] **Step 3: rest/skills.ts**
写计划「REST 封装」全文。
- [ ] **Step 4: rail「技能」入口**
`workspace-rail.tsx`:import `Blocks` from "lucide-react";在「更多」前(或后,视语义)加 `<RailNavItem icon={<Blocks className="h-5 w-5" />} label={t("rail.skills")} active={area === "skills"} onClick={() => router.push("/skills")} />`。
- [ ] **Step 5: 最小技能页**
`app/skills/page.tsx`(`"use client"`,仿 schedule 页):`AppShellLayout` 传 `sidebar={<SkillsSidebar .../>}`(本 Task 先用占位 `PlaceholderSidebar` 或简单 div;Task 2 出真侧栏)。主区:标题「技能」+ 调 `fetchInstalled()` 渲染已装名称/描述只读列表 + loading/空态。
- [ ] **Step 6: 文案 + 校验 + 提交**
`messages/zh.json`+`en.json` 加 `rail.skills`("技能"/"Skills")+ `skills` 段(title/installed/market/empty 等本 Task 用到的键);`pnpm --filter @meshbot/web-agent sync:locales --write`。`typecheck` + `pnpm test -- --roots apps/web-agent` + `pnpm check` + biome。提交。

---

### Task 2: 已装管理（侧栏 + 卸载 + 上传到我们的市场）

**Files:** Create `components/skills/skills-sidebar.tsx`、`installed-skill-card.tsx`、`publish-skill-dialog.tsx`;Modify `app/skills/page.tsx`(接真侧栏 + 卸载/上传交互)、`messages/*`。

**Interfaces — Consumes:** `fetchInstalled/uninstallSkill/publishSkill`(Task 1)。

- [ ] **Step 1: SkillsSidebar**
`skills-sidebar.tsx`:用 `SidebarSection` 渲染「已安装」段(列已装技能,点击高亮/滚动到主区对应卡——本期可仅展示)+「市场来源」段(我们的市场/GitHub/clawhub 三入口,点击切换主区视图)。props:`installed: InstalledSkill[]`、`activeSource: SkillInstallSource | "installed"`、`onSelect(view)`。样式仿 `messages-sidebar.tsx`。
- [ ] **Step 2: installed-skill-card + 卸载**
`installed-skill-card.tsx`(仿 `cron-job-card.tsx`):展示 name/description/source/version;操作:「卸载」(确认后调 `uninstallSkill(name)`,成功后从列表移除)、「上传到市场」(打开 publish 对话框,仅对本地/可上传项显示)。props:`skill`、`onUninstalled()`、`onPublish(skill)`。
- [ ] **Step 3: publish-skill-dialog**
`publish-skill-dialog.tsx`(仿 `cron-job-form.tsx` 的对话框/表单范式):字段 slug/displayName/version/changelog(name 取自所选已装技能,固定);提交调 `publishSkill({name,slug,displayName,version,changelog})`;成功提示 + 关闭。props:`skill: InstalledSkill | null`、`open`、`onOpenChange`、`onPublished()`。
- [ ] **Step 4: 页面接线 + 校验 + 提交**
`page.tsx`:接 `SkillsSidebar`(activeSource 状态)+ 已装区渲染 `installed-skill-card` 网格 + 卸载/上传交互 + publish 对话框。文案补全 + sync:locales。typecheck + test + check + biome。提交。

---

### Task 3: 市场浏览 + 安装（源选择 + 搜索 + GitHub 安装）

**Files:** Create `components/skills/market-skill-card.tsx`、`install-from-github.tsx`;Modify `app/skills/page.tsx`(市场视图)、`messages/*`。

**Interfaces — Consumes:** `fetchMarket/installSkill`(Task 1)、`SkillsSidebar` 的源切换(Task 2)。

- [ ] **Step 1: market-skill-card**
`market-skill-card.tsx`(仿 cron-job-card):展示 displayName/description/author/latestVersion/downloads;「安装」按钮调 `installSkill({source, ref:slug, version})`,安装中 loading,成功提示并刷新已装。props:`skill: MarketSkillSummary`、`source`、`onInstalled()`。
- [ ] **Step 2: 我们的市场 / clawhub 浏览视图**
`page.tsx`:当 activeSource ∈ {ourMarket, clawhub} 时:搜索框(关键字,防抖)→ `fetchMarket(source,q)` → 渲染 `market-skill-card` 网格 + loading/空态。clawhub 仅浏览(安装按钮在 clawhub 卡上禁用并提示「暂不支持安装,请用 GitHub 导入」——3c 中 clawhub fetchPackage 抛 SKILL_SOURCE_UNSUPPORTED)。
- [ ] **Step 3: install-from-github**
`install-from-github.tsx`:输入框 `owner/repo[@ref]` + 「安装」→ `installSkill({source:"github", ref})`;成功刷新已装 + 提示。当 activeSource==="github" 时主区展示它(GitHub 无检索,故无卡列表,只此输入 + 说明)。props:`onInstalled()`。
- [ ] **Step 4: 校验 + 提交**
文案补全 + sync:locales。typecheck + `pnpm test -- --roots apps/web-agent` + `pnpm check` + biome。提交。

## Self-Review
- **Spec 覆盖**:用户 3 点 → 点2(市场:浏览我们的市场/clawhub/github + 安装 + 上传)= Task2(上传)+Task3(浏览/安装);点3(本地技能管理页 + Slack 左对齐)= Task1(rail 入口 + 页)+Task2(已装管理)。点1(对话式管理 + 热加载)属 SP2/3c(skill_list 天然热,本期不做对话工具)。「总量统计/定时任务并入更多」属 SP0(本期不做)。
- **占位符**:rest 封装/areaFromPath/rail 入口给全码;组件给结构+props+REST 调用+参照现有组件(cron-job-card/messages-sidebar/sidebar-section/cron-job-form)匹配视觉——前端视觉按既有范式,逻辑/接线精确。
- **类型一致**:全程复用 `@meshbot/types-agent` 的 MarketSkillSummary/InstalledSkill/InstallSkillInput/PublishLocalSkillInput/SkillInstallSource,与 3c 后端一致。
- **约定**:Slack 风格复用 SidebarSection;新文案 sync:locales;前端测试只对 areaFromPath 加单测(本仓现实),组件靠 typecheck+biome。
- **风险**:apiClient.get 的 params 传参形态(`{params}` vs query 拼接)以 cron-jobs.ts 实际为准(Task1 标注);clawhub 安装本期禁用(后端不支持)。
