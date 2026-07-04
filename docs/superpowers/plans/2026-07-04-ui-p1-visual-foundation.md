# UI 重构 P1:视觉地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把两端(web-agent / web-main)的视觉底座收敛成一套共享 token + 自托管品牌字体,并清掉冗余原子别名——**换新皮、不改结构**,为后续 IA 重排(P2)与两端同壳(P3/P4)铺路。

**Architecture:** 三处改动,互相独立、各自可交付:①在 `@meshbot/design` 的 `globals.css` 引入单一品牌焦橙 `--brand:#d24a0d`,让 `--secondary`/`--ring`/`--shell-accent` 都指向它,并把 `--shell-*` 外壳 token 从 web-agent 局部**提升为共享**(顺带修复 web-main `--shell-accent` 悬空缺陷);②用 `next/font/google` 自托管 Hanken Grotesk 拉丁字体,经 Tailwind v4 `@theme` 的 `--font-sans` 应用;③删除 `design/index.ts` 里零消费的 `Ui{Button,Card,Input,Select}` 死别名,`apple` 系列成唯一原子。全程不动组件结构与业务逻辑。

**Tech Stack:** Next.js 16.2.4(App Router,静态导出)· React 19 · Tailwind v4(无 config,纯 CSS `@theme inline`)· `next/font/google`(自托管,构建期下载)· Biome · Turbo。

## Global Constraints

- **单一品牌橙**:全局强调色统一为**焦橙 `#d24a0d`**(收敛原 `--secondary:#f97316` 与 web-agent 局部 `--shell-accent:#d24a0d` 两个不一致的橙)。品牌炭黑 `#241c15`。橙**克制**——只用于强调/我方/流式,不铺满。
- **`--brand` 命名避让**:品牌橙**不可**复用 `--accent`(design 里 `--accent` 已是 shadcn 中性灰),新增 `--brand`。
- **字体自托管**:拉丁走 **Hanken Grotesk**,经 `next/font/google`(构建期拉取并自托管进产物,**运行时零外链 CDN**);中文回落系统 PingFang SC / 思源。禁止运行时外链字体(CSP/离线)。
- **不新增重依赖**:不引入 framer-motion 或状态机库。
- **Tailwind v4**:无 `tailwind.config.*`,token 只在 `packages/design/src/styles/globals.css` 定义;两 app 经 `@import "@meshbot/design/src/styles/globals.css"` 复用。
- **暗色**:沿用"暖炭·配橙"(oklch hue ~55,非纯灰)。P1 暗色品牌橙保持 `#d24a0d` 不提亮(提亮留待视觉对比轮,见风险)。
- **验证方式(重要)**:前端**无单测 runner**(web-agent/web-main/design 均无 jest/vitest/testing-library,根 jest 为 node-only 且排除 packages/)。本 plan 属纯 token/字体/导出改动,**不可单测**;验证一律走 **`typecheck` + `next build` + Biome `lint` + `pnpm check` 静态围栏 + `dev` 服务器人工视觉冒烟**。每个 task 给出具体冒烟清单作为可验证交付物。
- **工程纪律**:禁止 `--no-verify`;读命令完整输出(勿 tail/grep 掩盖失败);中文 conventional commits,提交信息末尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- **分支**:`feat/unified-ui-redesign`(已建,spec 已在其上)。

## 依赖包名与常用命令(实施者背景)

- 包名:`@meshbot/web-agent`(apps/web-agent,dev 端口 3001)· `@meshbot/web-main`(apps/web-main,dev 端口 3002)· `@meshbot/design`(packages/design,源码消费无构建)。
- 单包类型检查:`pnpm --filter @meshbot/web-agent typecheck` / `pnpm --filter @meshbot/web-main typecheck` / `pnpm --filter @meshbot/design typecheck`。全量:`pnpm typecheck`。
- 构建单个 Next app:`pnpm --filter @meshbot/web-agent build`(执行 `next build`;`next/font/google` 在此步下载并自托管字体)。
- 视觉冒烟:`pnpm dev:web-agent`(3001)、`pnpm dev:web-main`(3002)。
- 静态围栏:`pnpm check`;格式/静态:`pnpm lint`。

---

## File Structure

| 文件 | 改动 | 职责 |
|------|------|------|
| `packages/design/src/styles/globals.css` | 改 | 唯一 token 源:新增 `--brand`/`--brand-hover`、提升 `--shell-*`、重指 `--secondary`/`--ring`、`@theme` 加 `--font-sans`、`@layer base` 设 body 字体 |
| `apps/web-agent/src/app/globals.css` | 改 | 删除已提升的 `--shell-*`(:root 与 html.dark),仅保留 Electron/titlebar 与既有装饰规则 |
| `apps/web-agent/src/app/layout.tsx` | 改 | 引入 `next/font/google` Hanken Grotesk,把字体 CSS 变量挂到 `<html>` |
| `apps/web-main/src/app/layout.tsx` | 改 | 同上(每个 Next app 各自引入 next/font) |
| `packages/design/src/index.ts` | 改 | 删除零消费的 `Ui{Button,Card,Input,Select}` 死别名 |

无新建文件(next/font/google 无需入库 woff2)。

---

## Task 1:统一品牌焦橙 + 提升共享外壳 token(修 web-main 悬空)

把品牌橙收敛为单一 `--brand:#d24a0d`,并把 `--shell-*` 从 web-agent 局部提升进 design 共享层。改完:全局只有一种橙;web-main 里原本悬空(渲染无色)的 `bg-(--shell-accent)` 恢复为焦橙。

**Files:**
- Modify: `packages/design/src/styles/globals.css`(`:root` 第 45–79 行区、`.dark` 第 84–117 行区)
- Modify: `apps/web-agent/src/app/globals.css`(`:root` 第 123–133 行、`html.dark` 第 203–207 行)

**Interfaces:**
- Produces:CSS 变量 `--brand`、`--brand-hover`、以及共享化的 `--shell-chrome`/`--shell-sidebar`/`--shell-content`/`--shell-accent`/`--shell-accent-hover`/`--shell-radius`(供 P2+ 及 web-main 使用)。`--secondary`/`--ring` 现等于 `var(--brand)`。

- [ ] **Step 1:在 design `globals.css` 的 `:root` 引入 `--brand` 与共享 `--shell-*`**

在 `packages/design/src/styles/globals.css` 的 `:root {` 块内,`--radius: 0.5rem;` 之后**插入**:

```css
  /* 品牌焦橙:全局唯一强调色(收敛原 --secondary #f97316 与 web-agent 局部
     --shell-accent #d24a0d 两个不一致的橙)。--brand 不复用 --accent(那是 shadcn 中性灰)。 */
  --brand: #d24a0d;
  --brand-hover: #b03d0a;
  /* 外壳结构 token:从 web-agent 局部提升为共享(两端可用;修复 web-main --shell-accent 悬空)。 */
  --shell-chrome: #241c15;
  --shell-sidebar: #342a20;
  --shell-content: #ffffff;
  --shell-accent: var(--brand);
  --shell-accent-hover: var(--brand-hover);
  --shell-radius: 0.5rem;
```

- [ ] **Step 2:把 `:root` 里两个旧橙重指到 `--brand`**

同文件 `:root` 内,把这两行改为引用 `--brand`:

```css
  --secondary: var(--brand);
```
```css
  --ring: var(--brand);
```

(即原 `--secondary: #f97316;`、`--ring: #f97316;` 两行。`--secondary-foreground: #fafafa;` 保持不变。)

- [ ] **Step 3:在 `.dark` 块补暗色外壳色并重指旧橙**

同文件 `.dark {` 块内:把 `--secondary: #f97316;` 改为 `--secondary: var(--brand);`、`--ring: #f97316;` 改为 `--ring: var(--brand);`;并在该块末尾(`--sidebar-ring` 行之后)**插入**暗色外壳三色:

```css
  /* 暗色「暖炭·配橙」外壳:chrome 0.135(最暗外框/rail/顶栏) < content 0.155(=--background) < sidebar 0.195。 */
  --shell-chrome: oklch(0.135 0.008 55);
  --shell-sidebar: oklch(0.195 0.01 55);
  --shell-content: oklch(0.155 0.009 55);
```

(`--brand`/`--brand-hover`/`--shell-accent`/`--shell-radius` 暗色继承 `:root`,无需重写;P1 暗色品牌橙不提亮。)

- [ ] **Step 4:从 web-agent `globals.css` 删除已提升的 `--shell-*`**

在 `apps/web-agent/src/app/globals.css` 的 `:root {` 块(约 123–133 行)里,**删除**这 6 行(已移入 design 共享层),**保留** `--titlebar-height` 与 `--mac-controls-safe-left`:

```css
  /* Slack 风格外壳配色（web-agent 局部，不进共享 design 系统） */
  --shell-chrome: #241c15;
  --shell-sidebar: #342a20;
  --shell-content: #ffffff;
  --shell-accent: #d24a0d;
  --shell-accent-hover: #b03d0a;
  --shell-radius: 0.5rem;
```

删除后该 `:root` 块应只剩:

```css
:root {
  --titlebar-height: 42px;
  --mac-controls-safe-left: 92px;
}
```

- [ ] **Step 5:从 web-agent `globals.css` 删除 `html.dark` 外壳覆盖块**

同文件末尾(约 201–207 行),**删除**整段(已移入 design 的 `.dark`):

```css
/* 暗色模式「暖炭·配橙」：近黑炭底注入极低饱和暖色相(hue 55, chroma~0.01)，与橙同族、和谐去死灰。
   明度层次 chrome 0.135(最暗外框/rail/顶栏) < content 0.155(=--background) < sidebar 0.195。 */
html.dark {
  --shell-chrome: oklch(0.135 0.008 55);
  --shell-sidebar: oklch(0.195 0.01 55);
  --shell-content: oklch(0.155 0.009 55);
}
```

> 注:design 用 `.dark` 选择器(`html` 上加 `.dark` 时同样命中,且排在 `:root` 之后 → 暗色覆盖生效),与 web-agent `useTheme` 给 `<html>` 加 `.dark` 的行为一致。

- [ ] **Step 6:类型检查两 app**

Run:
```bash
pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-main typecheck
```
Expected:两个都 PASS(纯 CSS 改动不影响 TS,但确认无连带破坏)。

- [ ] **Step 7:构建两 app**

Run:
```bash
pnpm --filter @meshbot/web-agent build && pnpm --filter @meshbot/web-main build
```
Expected:两个 `next build` 均成功。

- [ ] **Step 8:视觉冒烟(关键——验证 web-main 悬空修复)**

Run:`pnpm dev:web-main`,浏览器开 `http://localhost:3002`,进 IM 会话页。
检查清单:
- 消息气泡(`im-message-list.tsx` 的 agent 头像、`im-conversation.tsx` 的发送按钮/头像)**橙色正常显示**(修复前是无色/透明)。

Run:`pnpm dev:web-agent`,开 `http://localhost:3001`。
检查清单:
- rail 选中态、session 列表选中项、顶栏 ✦随手问 开关、IM 头像——橙色仍为 `#d24a0d`,与改前**观感一致**(无回归)。
- 切换深色(rail 底部主题开关):rail/侧栏/内容区暖炭三层次正常,橙色强调仍在。

- [ ] **Step 9:提交**

```bash
git add packages/design/src/styles/globals.css apps/web-agent/src/app/globals.css
git commit -m "feat(ui): 统一品牌焦橙 --brand#d24a0d 并提升共享外壳 token

收敛原 --secondary#f97316 与 web-agent 局部 --shell-accent#d24a0d 两个橙为单一 --brand;
--secondary/--ring/--shell-accent 均指向 --brand;--shell-* 从 web-agent 提升进 design 共享层，
修复 web-main 内 bg-(--shell-accent) 悬空(此前渲染无色)。纯 token 改动，不动结构。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2:自托管品牌字体 Hanken Grotesk

用 `next/font/google` 把 Hanken Grotesk 引入两 app(构建期下载、自托管进产物、运行时零外链),经 Tailwind v4 `--font-sans` 全局应用;中文回落系统字体。

**Files:**
- Modify: `apps/web-agent/src/app/layout.tsx`
- Modify: `apps/web-main/src/app/layout.tsx`
- Modify: `packages/design/src/styles/globals.css`(`@theme inline` 加 `--font-sans`、`@layer base` 设 body 字体)

**Interfaces:**
- Consumes:无(独立于 Task 1)。
- Produces:CSS 变量 `--font-hanken`(每 app 由 next/font 注入到 `<html>`)、`--font-sans`(design `@theme`,供 `font-sans` 工具类与 body 默认字体)。

- [ ] **Step 1:web-agent 根 layout 接入 next/font**

在 `apps/web-agent/src/app/layout.tsx` 顶部 import 区**新增**:

```tsx
import { Hanken_Grotesk } from "next/font/google";
```

在 `metadata` 声明之后、`RootLayout` 之前**新增**字体实例:

```tsx
const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-hanken",
});
```

把 `<html lang="zh" suppressHydrationWarning>` 改为挂上字体变量类:

```tsx
    <html lang="zh" suppressHydrationWarning className={hanken.variable}>
```

- [ ] **Step 2:web-main 根 layout 接入 next/font**

在 `apps/web-main/src/app/layout.tsx` 顶部 import 区**新增**:

```tsx
import { Hanken_Grotesk } from "next/font/google";
```

在 `metadata` 之后、`RootLayout` 之前**新增**:

```tsx
const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-hanken",
});
```

把 `<html lang="zh-CN">` 改为:

```tsx
    <html lang="zh-CN" className={hanken.variable}>
```

- [ ] **Step 3:design `@theme` 注册 `--font-sans` 并设 body 默认字体**

在 `packages/design/src/styles/globals.css` 的 `@theme inline {` 块内(任意位置,建议紧接 `--color-*` 之后)**新增**:

```css
  --font-sans: var(--font-hanken), ui-sans-serif, system-ui, -apple-system,
    "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", sans-serif;
```

在同文件 `@layer base {` 块的 `body { ... }` 规则内**新增**一行 `font-family`(与既有 `background-color`/`color` 并列):

```css
    font-family: var(--font-sans);
```

> 说明:`--font-hanken` 由各 app 的 next/font 注入到 `<html>`;design 的 `--font-sans` 引用它并回落系统/中文字体。Tailwind v4 会据 `--font-sans` 生成 `font-sans` 工具类,同时 body 直接吃该字体作全局默认。

- [ ] **Step 4:类型检查两 app**

Run:
```bash
pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-main typecheck
```
Expected:两个都 PASS。

- [ ] **Step 5:构建两 app(验证 next/font 构建期下载 + 自托管)**

Run:
```bash
pnpm --filter @meshbot/web-agent build && pnpm --filter @meshbot/web-main build
```
Expected:两个 `next build` 均成功;构建日志中 next/font 无报错(需构建机可访问 Google Fonts 拉取一次,产物自托管;若构建环境无网络则此步会失败——属环境问题,向发起人上报,不改方案)。

- [ ] **Step 6:视觉冒烟**

Run `pnpm dev:web-agent`(3001)与 `pnpm dev:web-main`(3002)。检查清单:
- 拉丁字母/数字(标题、按钮、时间戳、token 用量数字)呈现 Hanken Grotesk 的几何人文体形态,**与改前系统默认体明显不同**。
- 中文字符正常(回落 PingFang SC,不豆腐块、不错位)。
- DevTools 里 `<html>` 元素带 `--font-hanken` 变量类,`body` 计算样式 `font-family` 首选为该字体。

- [ ] **Step 7:提交**

```bash
git add apps/web-agent/src/app/layout.tsx apps/web-main/src/app/layout.tsx packages/design/src/styles/globals.css
git commit -m "feat(ui): 自托管 Hanken Grotesk 品牌字体

两 app 经 next/font/google 引入 Hanken Grotesk(构建期下载、自托管、运行时零外链 CDN)，
经 Tailwind v4 --font-sans 全局应用，中文回落 PingFang SC。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3:收敛 design 原子——删除零消费的 `Ui*` 死别名

`Ui{Button,Card,Input,Select}` 在两 app **零 import**(grep 确认),是冗余别名。删除后 `apple` 系列(`Button`/`Card`/`Input`/`Select`)成唯一原子出口;真正被用的 ui-only 组件(Alert/Dropdown/Form/Label/Progress/Table/Tooltip)保留。

**Files:**
- Modify: `packages/design/src/index.ts`

**Interfaces:**
- Consumes:无。
- Produces:`@meshbot/design` 不再导出 `UiButton`/`uiButtonVariants`/`UiButtonProps`/`UiCard*`/`UiInput`/`UiSelect*`。

- [ ] **Step 1:确认零消费(前置验证)**

Run:
```bash
grep -rn "UiButton\|UiCard\|UiInput\|UiSelect\|uiButtonVariants" apps packages --include="*.ts" --include="*.tsx" | grep -v "packages/design/src/index.ts"
```
Expected:**无任何输出**(除 index.ts 自身的导出行外无消费者)。若有输出,停止并上报(说明有消费者,需先迁移)。

- [ ] **Step 2:删除 `index.ts` 中的 Ui* 别名导出**

在 `packages/design/src/index.ts` 中**删除**以下四段导出(保留其余全部,尤其保留第 27 行的 `Alert*`、`DropdownMenu*`、`Form*`、`Label`、`Progress`、`Table*`、`Tooltip*`):

删除 `UiButton` 段:
```ts
export {
  Button as UiButton,
  type ButtonProps as UiButtonProps,
  buttonVariants as uiButtonVariants,
} from "./components/ui/button";
```
删除 `UiCard` 段:
```ts
export {
  Card as UiCard,
  CardContent as UiCardContent,
  CardDescription as UiCardDescription,
  CardFooter as UiCardFooter,
  CardHeader as UiCardHeader,
  CardTitle as UiCardTitle,
} from "./components/ui/card";
```
删除 `UiInput` 行:
```ts
export { Input as UiInput } from "./components/ui/input";
```
删除 `UiSelect` 段:
```ts
export {
  Select as UiSelect,
  SelectContent as UiSelectContent,
  SelectGroup as UiSelectGroup,
  SelectItem as UiSelectItem,
  SelectLabel as UiSelectLabel,
  SelectScrollDownButton as UiSelectScrollDownButton,
  SelectScrollUpButton as UiSelectScrollUpButton,
  SelectSeparator as UiSelectSeparator,
  SelectTrigger as UiSelectTrigger,
  SelectValue as UiSelectValue,
} from "./components/ui/select";
```

> 保留 `./components/ui/button.tsx` 等**文件本身**(apple 组件内部仍从 `../ui/button` 引用),仅删 `index.ts` 的重导出。

- [ ] **Step 3:类型检查(design + 两 app)**

Run:
```bash
pnpm --filter @meshbot/design typecheck && pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-main typecheck
```
Expected:三个都 PASS(删的是零消费导出,不应有任何 TS 断裂)。

- [ ] **Step 4:构建两 app**

Run:
```bash
pnpm --filter @meshbot/web-agent build && pnpm --filter @meshbot/web-main build
```
Expected:均成功。

- [ ] **Step 5:提交**

```bash
git add packages/design/src/index.ts
git commit -m "refactor(design): 删除零消费的 Ui{Button,Card,Input,Select} 别名

apple 系列成唯一原子出口;被使用的 ui-only 组件(Alert/Dropdown/Form/Label/
Progress/Table/Tooltip)保留。grep 确认两 app 零 import 这些别名。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾:全量围栏

- [ ] **Step 1:跑静态围栏 + 全量类型检查**

Run:
```bash
pnpm check && pnpm typecheck
```
Expected:围栏全绿;全包 typecheck PASS。

- [ ] **Step 2:Biome 格式/静态**

Run:`pnpm lint`
Expected:无新增告警(如 next/font import 顺序被 Biome 调整,接受其 autofix 后重新 `git add` 并 amend 最近一次提交)。

---

## Self-Review(plan 对 spec 核对)

**1. Spec 覆盖**(对 `2026-07-04-unified-ui-redesign-design.md` §6 视觉 token / §7.4 原子收敛 / §12 P1):
- §6.1 单一焦橙 `#d24a0d` + 修 `--shell-accent` 悬空 + `--shell-*` 提升共享 → Task 1 ✅
- §6.3 Hanken/Manrope 自托管字体 → Task 2(选 Hanken Grotesk)✅
- §7.4 / §12-P1 apple/ui 原子收敛 → Task 3 ✅
- §6.1 `--brand` 命名避让 `--accent`(shadcn 中性灰)→ Global Constraints + Task 1 已显式处理 ✅
- §6.2 字号阶 / §6.4 圆角形制:属**组件层**落地,归 P2/P3(P1 只铺 token 底座与字体),本 plan 不含——符合 §12 分期。

**2. 占位符扫描**:无 TBD/TODO;每个 code step 给出确切 CSS/TSX 片段与确切命令。构建期字体下载失败被显式定性为"环境问题上报",非占位。

**3. 类型/命名一致**:`--brand`/`--brand-hover`/`--font-hanken`/`--font-sans` 全 plan 拼写一致;`--shell-*` six 变量名与现有代码 38+ 处引用完全一致(仅移动定义位置,不改名),故无连带改动。

**4. 范围**:P1 单一可交付(换皮不改结构),独立成 plan;P2(IA 重排)因涉及路由/信息架构、风险与验证方式都不同,**另行成 plan**(见下)。

## 关于 P2

本 plan 有意**只覆盖 P1**。P2(web-agent IA 重排:rail 6 项、助手/消息二级拆分、统一 52px header 带、右区双层)涉及路由改造与信息架构变动,是与 P1 独立、可单独交付的子系统,按 writing-plans 的 scope-check 应各自成 plan。P1 合入后另起 `2026-07-05-ui-p2-web-agent-ia.md`(或同日续号)。
