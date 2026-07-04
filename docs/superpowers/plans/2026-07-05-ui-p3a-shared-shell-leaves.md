# UI 重构 P3a:共享壳叶子件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `@meshbot/web-common/shell` 源码直连子入口,把 5 个**纯展示的壳叶子件**(rail/sidebar 原子 + page-header)从 web-agent 抽进去,web-agent 改为消费——为 P4(web-main 用上共享壳)铺第一块地基。

**Architecture:** web-common 现走 dist 构建,但带 Tailwind class 的 React 组件源码直连才不摩擦——所以给 web-common 加一个**指向 `src/shell` 的 `./shell` 导出**(仿 `@meshbot/design` 的 `./src/*` 源码消费,package 主体 `.`/`./react` 仍走 dist)。5 个叶子件是**纯展示(只 props + `cn` + lucide + react)**,原样搬入,import 不变;web-agent 各处改为 `import { ... } from "@meshbot/web-common/shell"`,Tailwind 经新增 `@source` 扫到这些 class。数据/逻辑组件本期不碰。

**Tech Stack:** TypeScript(NodeNext)· React 19 · Tailwind v4(`@source` 扫描源码)· pnpm workspace · Turbo。

## Global Constraints

- **落点 = `@meshbot/web-common/shell`,源码直连**(export 指向 `./src/shell/index.ts`,不走 dist);package 主体 `.`/`./react` 保持 dist 不变。
- **只抽纯展示叶子(5 个)**:`rail-nav-item`、`sidebar-nav-item`、`sidebar-section`、`sidebar-skeleton`、`page-header`。**不抽** `tool-page`/`shell-refs-context`(依赖 B 类 `PageShell`)、以及任何用 atoms/rest/ws/导航的组件(留后续期)。
- **组件保持纯展示**:搬入后 import 仍是 `cn`(`@meshbot/design`)+ `lucide-react` + `react`,**不引入任何 `@/` app 别名 / atoms / rest**。
- **样式 token 不变**:组件用的 `--shell-sidebar-fg`/`--shell-accent`/`--shell-radius` 等由 design 共享 globals.css 提供(两端都 import),搬包后照常解析。
- **web-agent 零回归**:抽完 web-agent 视觉/行为不变(同样的组件,只换 import 来源 + 删本地副本)。
- **web-main 本期不动**(P4 才让它用上;本期只建包 + web-agent 消费)。
- **验证**:`pnpm --filter @meshbot/web-common typecheck`(jsx 生效)+ `pnpm --filter @meshbot/web-agent typecheck && build`(无回归)+ 人工冒烟(侧栏 nav 项/分组/骨架、页头显示正常)。
- 禁 `--no-verify`;中文 commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;分支 `feat/ui-p3a-shared-leaves`(已基于 main 建)。

## 依赖与命令
web-common typecheck:`pnpm --filter @meshbot/web-common typecheck`。web-agent:`pnpm --filter @meshbot/web-agent typecheck` / `build`(timeout 600000)。冒烟 `pnpm dev:web-agent`。

---

## File Structure

| 文件 | 改动 | 职责 |
|------|------|------|
| `packages/web-common/tsconfig.json` | 改 | 加 `"jsx": "react-jsx"`(编译 TSX) |
| `packages/web-common/package.json` | 改 | 加 deps `@meshbot/design`、`lucide-react`;加 `./shell` 源码导出 |
| `packages/web-common/src/shell/{rail-nav-item,sidebar-nav-item,sidebar-section,sidebar-skeleton,page-header}.tsx` | 建 | 5 个纯展示叶子(从 web-agent 原样搬) |
| `packages/web-common/src/shell/index.ts` | 建 | 桶导出 5 件 |
| `apps/web-agent/src/app/globals.css` | 改 | 加 `@source` 扫 web-common/src/shell |
| web-agent ~13 处 consumer | 改 | import 来源换 `@meshbot/web-common/shell` |
| web-agent 5 个本地叶子件文件 | 删 | 已迁至共享包 |

---

## Task 1:建 `@meshbot/web-common/shell` 入口 + 5 叶子件(web-agent 暂不动)

先把共享包搭好、组件放进去、web-common 自身 typecheck 过;此步**不碰 web-agent**(本地副本仍在,web-agent 不受影响),避免中间破态。

**Files:**
- Modify: `packages/web-common/tsconfig.json`、`packages/web-common/package.json`
- Create: `packages/web-common/src/shell/rail-nav-item.tsx`、`sidebar-nav-item.tsx`、`sidebar-section.tsx`、`sidebar-skeleton.tsx`、`page-header.tsx`、`index.ts`

- [ ] **Step 1:web-common tsconfig 开 jsx**

在 `packages/web-common/tsconfig.json` 的 `compilerOptions` 里加一行:

```json
    "jsx": "react-jsx",
```

- [ ] **Step 2:web-common package.json 加依赖 + `./shell` 导出**

在 `packages/web-common/package.json` 的 `dependencies` 里加:

```json
    "@meshbot/design": "workspace:*",
    "lucide-react": "^0.468.0",
```

在 `exports` 里、`"./react"` 之后加(源码直连,仿 design):

```json
    "./shell": {
      "types": "./src/shell/index.ts",
      "default": "./src/shell/index.ts"
    }
```

- [ ] **Step 3:装依赖**

Run:`pnpm install`
Expected:成功;`@meshbot/design`/`lucide-react` 进 web-common node_modules(workspace 链接)。

- [ ] **Step 4:搬入 5 个叶子件(原样)**

把这 5 个文件从 `apps/web-agent/src/components/{shell,layouts}/` **复制**到 `packages/web-common/src/shell/`(内容一字不改——它们只 import `cn`/`lucide-react`/`react`,无 `@/` 别名):
- `apps/web-agent/src/components/shell/rail-nav-item.tsx` → `packages/web-common/src/shell/rail-nav-item.tsx`
- `apps/web-agent/src/components/shell/sidebar-nav-item.tsx` → `packages/web-common/src/shell/sidebar-nav-item.tsx`
- `apps/web-agent/src/components/shell/sidebar-section.tsx` → `packages/web-common/src/shell/sidebar-section.tsx`
- `apps/web-agent/src/components/shell/sidebar-skeleton.tsx` → `packages/web-common/src/shell/sidebar-skeleton.tsx`
- `apps/web-agent/src/components/layouts/page-header.tsx` → `packages/web-common/src/shell/page-header.tsx`

用 `cp`(不是 git mv——本步不删原文件):
```bash
cp apps/web-agent/src/components/shell/rail-nav-item.tsx packages/web-common/src/shell/rail-nav-item.tsx
cp apps/web-agent/src/components/shell/sidebar-nav-item.tsx packages/web-common/src/shell/sidebar-nav-item.tsx
cp apps/web-agent/src/components/shell/sidebar-section.tsx packages/web-common/src/shell/sidebar-section.tsx
cp apps/web-agent/src/components/shell/sidebar-skeleton.tsx packages/web-common/src/shell/sidebar-skeleton.tsx
cp apps/web-agent/src/components/layouts/page-header.tsx packages/web-common/src/shell/page-header.tsx
```

- [ ] **Step 5:桶导出** — 新建 `packages/web-common/src/shell/index.ts`:

```ts
export { RailNavItem } from "./rail-nav-item";
export { SidebarNavItem } from "./sidebar-nav-item";
export { SidebarSection } from "./sidebar-section";
export { SidebarSkeleton } from "./sidebar-skeleton";
export { PageHeader } from "./page-header";
```

> 若某组件是 default export 而非具名,按其实际导出改(先 `grep -n "export" <file>` 确认;这 5 个应为具名 `export function X`)。

- [ ] **Step 6:web-common typecheck(验 jsx + 依赖解析)**

Run:`pnpm --filter @meshbot/web-common typecheck`
Expected:PASS(jsx 生效、`cn`/`lucide-react` 解析成功)。若报 `--jsx` 未设或找不到 React 类型,回查 Step 1/2。

- [ ] **Step 7:提交**

```bash
git add packages/web-common
git commit -m "feat(web-common): 新增 ./shell 源码直连子入口 + 5 个纯展示壳叶子件

rail-nav-item/sidebar-nav-item/sidebar-section/sidebar-skeleton/page-header 原样搬入;
tsconfig 开 jsx;加 @meshbot/design + lucide-react 依赖;./shell 指向 src(不走 dist)。
web-agent 暂仍用本地副本,下一 task 切换。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2:web-agent 改用共享壳 + 删本地副本 + Tailwind @source

**Files:**
- Modify: `apps/web-agent/src/app/globals.css`
- Modify: web-agent 中 import 这 5 件的所有文件(约 13 处)
- Delete: web-agent 本地的 5 个叶子件文件

**Interfaces:**
- Consumes:`RailNavItem`/`SidebarNavItem`/`SidebarSection`/`SidebarSkeleton`/`PageHeader`(from `@meshbot/web-common/shell`)。

- [ ] **Step 1:Tailwind 扫描共享壳源码**

在 `apps/web-agent/src/app/globals.css` 已有的 `@source "../../../../packages/design/src";` 之后加一行:

```css
@source "../../../../packages/web-common/src/shell";
```

(否则这 5 件里的 class 不会被生成。)

- [ ] **Step 2:改所有 consumer 的 import 来源**

先定位所有引用:
```bash
grep -rln "components/shell/rail-nav-item\|components/shell/sidebar-nav-item\|components/shell/sidebar-section\|components/shell/sidebar-skeleton\|components/layouts/page-header" apps/web-agent/src
```

对每个命中文件,把对这 5 件的 import 从本地路径改为共享包。例如:
- `import { RailNavItem } from "@/components/shell/rail-nav-item";` → `import { RailNavItem } from "@meshbot/web-common/shell";`
- `import { SidebarNavItem } from "@/components/shell/sidebar-nav-item";` → 同上
- `import { SidebarSection } from "@/components/shell/sidebar-section";` → 同上
- `import { SidebarSkeleton } from "@/components/shell/sidebar-skeleton";` → 同上
- `import { PageHeader } from "@/components/layouts/page-header";` → `import { PageHeader } from "@meshbot/web-common/shell";`

同一文件若引多个,合并成一条 `import { A, B } from "@meshbot/web-common/shell";`。**不要**动这些组件的用法(props 不变)。

> 注:`tool-page.tsx` 引 `PageHeader` —— 它本身本期不迁,但它对 `PageHeader` 的 import 也要改成共享包(`PageHeader` 已迁走)。`PageShell` 仍是本地(不迁)。

- [ ] **Step 3:删本地 5 个副本**

```bash
git rm apps/web-agent/src/components/shell/rail-nav-item.tsx apps/web-agent/src/components/shell/sidebar-nav-item.tsx apps/web-agent/src/components/shell/sidebar-section.tsx apps/web-agent/src/components/shell/sidebar-skeleton.tsx apps/web-agent/src/components/layouts/page-header.tsx
```

- [ ] **Step 4:确认无残留本地引用**

Run:
```bash
grep -rn "components/shell/rail-nav-item\|components/shell/sidebar-nav-item\|components/shell/sidebar-section\|components/shell/sidebar-skeleton\|components/layouts/page-header" apps/web-agent/src
```
Expected:**无输出**(所有引用已转共享包,本地文件已删)。

- [ ] **Step 5:typecheck + build**

Run:`pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`(timeout 600000)
Expected:PASS(找不到已删本地文件 = 有 consumer 没改到,回 Step 2)。

- [ ] **Step 6:视觉冒烟(人工)** — `pnpm dev:web-agent`:侧栏 nav 项(频道/私信/会话)、可折叠分组(带 +)、加载骨架、各页页头(技能/网盘/更多)显示与改前**完全一致**(暖米浅色下深字、选中态、hover 都在)。这些 class 现由 web-common/src/shell 提供、Tailwind 经新 @source 生成。

- [ ] **Step 7:提交**

```bash
git add -A
git commit -m "refactor(web-agent): 5 个壳叶子件改用 @meshbot/web-common/shell

rail/sidebar 原子 + page-header 从本地删除,统一从共享壳消费;globals.css 加 @source
扫 web-common/src/shell 让 Tailwind 生成其 class。web-agent 视觉零回归。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾
- [ ] **Step 1:全量围栏** — `pnpm typecheck && pnpm check`;Expected 全绿。
- [ ] **Step 2:确认共享包被正确消费** — `grep -rn "@meshbot/web-common/shell" apps/web-agent/src | wc -l`(应 >0)。

---

## Self-Review
**1. 覆盖**:建 `./shell` 源码入口 ✅;抽 5 纯叶子 ✅;web-agent 消费 + 删本地 ✅;Tailwind @source ✅;web-main 不动(P4)✅。
**2. 占位符**:token 名/路径/命令确切;`cp` vs `git rm` 两步分明(Task1 复制不删→无中间破态,Task2 才删)。
**3. 一致**:5 个组件名(RailNavItem/SidebarNavItem/SidebarSection/SidebarSkeleton/PageHeader)在导出/import 一致;`./shell` 导出仿 design `./form`/`./hooks` 源码模式。
**4. 风险**:web-common 加 `@meshbot/design`/`lucide-react` 依赖 + jsx —— Step 6 web-common typecheck 单独验;中间态由"Task1 只复制不删"避免;Tailwind 漏扫由 @source(Task2-S1)+ 人工冒烟兜底。

## 关于 P3b+(后续)
P3b 统一 `im-message-list`(消两端重复,最高 ROI);P3c B 类注入(page-shell/session-header/message-list…);P3d+ C 类 adapter 契约(rail/sidebar/dock/conversation-body)。各自成 plan。
