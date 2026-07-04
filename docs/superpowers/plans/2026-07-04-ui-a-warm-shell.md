# UI 重构 A:暖米浅色壳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 web-agent 二级侧栏从深色(Slack 长相)换成**暖米浅色**(落法 A:深 rail 保留作品牌锚 + 侧栏暖米浅 + 内容白),让浅色模式一眼不像 Slack;深色模式保持深炭。顺带清掉 P2b 遗留的死代码与小尾巴。

**Architecture:** 核心是**一次原子替换**:①浅色 `--shell-sidebar` 从深炭 `#342a20` → 暖米 `#f6f1ea`,并新增 `--shell-sidebar-fg`/`-hover`/`-border` 三个随主题翻转的 token(浅=深字/暖底、深=浅字/炭底);②把 6 个侧栏组件里**写死的白**(`text-white`/`bg-white/N`/`border-white/8`)全部换成这些 token,选中项从橙底改为**白卡+浅阴影**(如 mockup)。token 变更与组件替换**必须同一提交**(否则中间态=白字配暖底不可读)。rail(深炭)与内容(白)不动。

**Tech Stack:** Tailwind v4(任意值 `bg-(--var)`/`text-(--var)/85` 语法)· React 19 · lucide-react。纯样式,无逻辑。

## Global Constraints

- **落法 A(已定)**:深 rail `#241c15` **不动** · 侧栏浅色=暖米 `#f6f1ea` / 深色=深炭(翻转)· 内容区白 `#fff` **不动**。
- **选中项 = 白卡**:侧栏选中项从橙底(`bg-(--shell-accent) text-white`)改为 `bg-(--shell-content)` 白卡 + `shadow-sm` + 深字,**活动橙点保留**(选中的橙色标识靠圆点,不靠整条橙底)。未读 badge、rail 选中图标、我方气泡等**橙色照旧**(橙仍在,只是不铺满侧栏)。
- **主题翻转靠 token 不写死**:侧栏文字/hover/边框一律用 `--shell-sidebar-fg`/`--shell-sidebar-hover`/`--shell-sidebar-border`(浅深各定义),**禁止**再出现 `text-white`/`bg-white/N`/`border-white/N` 于侧栏组件。
- **两模式都要验**:因 token 浅深翻转,视觉冒烟**必须同时看浅色与深色**(深色应与改前基本一致)。
- 视觉沿用 P1 焦橙/字体;不引新依赖。
- **验证方式**:纯 CSS/class 改动不可单测;走 typecheck + next build + 人工浅/深双模式冒烟。
- i18n 无新增。禁 `--no-verify`;中文 commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;分支 `feat/ui-warm-shell`(已基于 main 建)。

## 依赖与命令
包名 `@meshbot/web-agent`。typecheck `pnpm --filter @meshbot/web-agent typecheck`;build `pnpm --filter @meshbot/web-agent build`(timeout 600000);冒烟 `pnpm dev:web-agent`(rail 底部切浅/深)。

---

## Task 1:暖米浅色侧栏(token + 组件 + 选中白卡,原子)

**Files:**
- Modify: `packages/design/src/styles/globals.css`(`:root` 与 `.dark`)
- Modify(去写死白,套映射表):`apps/web-agent/src/components/shell/assistant-sidebar.tsx`、`messages-sidebar.tsx`、`more-sidebar.tsx`、`sidebar-nav-item.tsx`、`sidebar-section.tsx`、`sidebar-skeleton.tsx`、`apps/web-agent/src/components/sidebar/session-list-item.tsx`

- [ ] **Step 1:design token —— 浅色侧栏改暖米 + 新增翻转 token**

在 `packages/design/src/styles/globals.css` 的 `:root {}` 里:把 `--shell-sidebar: #342a20;` 改为暖米:

```css
  --shell-sidebar: #f6f1ea;
```

并在其后新增三行(浅色:深字 / 暖 hover / 暖边):

```css
  --shell-sidebar-fg: #241c15;
  --shell-sidebar-hover: rgba(36, 28, 21, 0.06);
  --shell-sidebar-border: #e6ded4;
```

在 `.dark {}` 里,`--shell-sidebar: oklch(0.195 0.01 55);` **保持不变**(深色侧栏仍深炭),在其后新增三行(深色:浅字 / 白 hover / 炭边):

```css
  --shell-sidebar-fg: oklch(0.96 0.005 55);
  --shell-sidebar-hover: rgba(255, 255, 255, 0.08);
  --shell-sidebar-border: oklch(0.275 0.01 55);
```

- [ ] **Step 2:套映射表替换所有侧栏组件里的写死白**

对 Task 1 Files 列出的 **7 个组件**,把每处旧 class 按下表替换(逐处;`grep -n "white" <file>` 定位)。这些组件的**容器仍是 `bg-(--shell-sidebar)`**(值已在 Step 1 变暖米,不用改容器 class)。

| 旧 class | 新 class |
|---|---|
| `text-white` | `text-(--shell-sidebar-fg)` |
| `text-white/85` | `text-(--shell-sidebar-fg)/85` |
| `text-white/80` | `text-(--shell-sidebar-fg)/80` |
| `text-white/75` | `text-(--shell-sidebar-fg)/75` |
| `text-white/70` | `text-(--shell-sidebar-fg)/70` |
| `text-white/55` | `text-(--shell-sidebar-fg)/55` |
| `text-white/50` | `text-(--shell-sidebar-fg)/50` |
| `hover:text-white` | `hover:text-(--shell-sidebar-fg)` |
| `hover:text-white/80` | `hover:text-(--shell-sidebar-fg)/80` |
| `hover:text-white/75` | `hover:text-(--shell-sidebar-fg)/75` |
| `hover:bg-white/12` | `hover:bg-(--shell-sidebar-hover)` |
| `hover:bg-white/10` | `hover:bg-(--shell-sidebar-hover)` |
| `bg-white/10`(骨架块) | `bg-(--shell-sidebar-fg)/10` |
| `bg-white/30`(离线点) | `bg-(--shell-sidebar-fg)/30` |
| `border-white/8` | `border-(--shell-sidebar-border)` |

**不动**:`bg-green-400`(在线点绿,保留);未读 badge 的 `bg-(--shell-accent)`(橙,保留);`bg-(--shell-sidebar)` 容器(值已变)。

替换后,对这 7 个文件跑 `grep -n "text-white\|bg-white\|border-white\|white/" <file>` 应**无输出**(除 `bg-green-400` 这类非 white 命中——它不含 `white`,不会命中)。

- [ ] **Step 3:选中项改白卡(SessionListItem 与 SidebarNavItem)**

`apps/web-agent/src/components/sidebar/session-list-item.tsx`:
- 行内 active 判定块(约 108-113)`active ? "bg-(--shell-accent) text-white" : "text-white/85 hover:bg-white/12 hover:text-white"` 改为:

```tsx
          active
            ? "bg-(--shell-content) text-(--shell-sidebar-fg) shadow-sm"
            : "text-(--shell-sidebar-fg)/85 hover:bg-(--shell-sidebar-hover)",
```

- Sparkles 图标(约 115-119)`active ? "text-white" : "text-white/70 group-hover:text-white"` 改为(选中橙、未选灰):

```tsx
            active
              ? "text-(--shell-accent)"
              : "text-(--shell-sidebar-fg)/60 group-hover:text-(--shell-sidebar-fg)",
```

- 活动圆点(约 142)`bg-(--shell-accent)` **保留橙**。三点菜单按钮(约 154)`text-white/70 hover:text-white` → `text-(--shell-sidebar-fg)/70 hover:text-(--shell-sidebar-fg)`。

`apps/web-agent/src/components/shell/sidebar-nav-item.tsx`(约 34-37):

```tsx
        active
          ? "bg-(--shell-content) text-(--shell-sidebar-fg) shadow-sm"
          : "text-(--shell-sidebar-fg)/80 hover:bg-(--shell-sidebar-hover)",
```

> 说明:选中=白卡(浅色白 / 深色 `--shell-content` 深卡,均带 `shadow-sm`),深浅自动翻;橙色靠活动圆点 + 未读 badge 保留,不再整条橙底。

- [ ] **Step 4:typecheck + build**

Run:`pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`(timeout 600000)。Expected:PASS。

- [ ] **Step 5:视觉冒烟(人工,浅+深双验)** — `pnpm dev:web-agent`:
  - **浅色**:侧栏暖米 `#f6f1ea`、深字清晰、分组标签/图标可读;选中会话=白卡+浅阴影+橙点;hover 淡暖;未读 badge 橙;rail 仍深炭、内容仍白。整体"不像 Slack"。
  - **深色**(rail 底部切换):侧栏仍深炭、浅字、选中=深卡,与改前基本一致、无回归。
  - 助手区 + 消息区两侧栏都看;骨架态(首屏加载)在浅色下不刺眼。

- [ ] **Step 6:提交**

```bash
git add packages/design/src/styles/globals.css apps/web-agent/src/components/shell apps/web-agent/src/components/sidebar/session-list-item.tsx
git commit -m "feat(web-agent): 暖米浅色侧栏(落法 A)

浅色 --shell-sidebar #342a20→#f6f1ea + 新增 --shell-sidebar-fg/-hover/-border(随主题翻转);
6 个侧栏组件去写死白改语义 token;选中项橙底→白卡+浅阴影(橙点保留)。rail/内容不动,深色保持。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2:清 P2b 遗留(死代码 + ✦ 按钮 + 小尾巴)

P2b 右区重构后产生的死代码与已知 Minor,一并清掉(A 期在动壳,顺带)。

**Files:**
- Delete: `apps/web-agent/src/components/artifact/artifact-preview-panel.tsx`、`apps/web-agent/src/components/im/dock-tabs.tsx`
- Modify: `apps/web-agent/src/atoms/assistant-panel.ts`(删 `assistantPanelTypeAtom`、`previewPanelWidthAtom`)、`apps/web-agent/src/components/shell/shell-top-bar.tsx`(✦ 按钮)、`apps/web-agent/src/components/artifact/artifact-fullscreen.tsx`(头 52px)、`apps/web-agent/src/hooks/use-auto-open-artifact.ts`(陈旧注释)、`apps/web-agent/src/components/session/tools-panel.tsx`(useMemo)

- [ ] **Step 1:确认死代码零引用后删除**

Run:`grep -rn "artifact-preview-panel\|ArtifactPreviewPanel\|dock-tabs\|DockTabs" apps/web-agent/src --include="*.tsx" --include="*.ts" | grep -v "components/artifact/artifact-preview-panel.tsx\|components/im/dock-tabs.tsx"`
Expected:**无输出**(除文件自身)。若有引用,停止上报。确认后删两个文件:
```bash
git rm apps/web-agent/src/components/artifact/artifact-preview-panel.tsx apps/web-agent/src/components/im/dock-tabs.tsx
```

- [ ] **Step 2:删两个孤儿 atom**

先 `grep -rn "assistantPanelTypeAtom\|previewPanelWidthAtom" apps/web-agent/src`,确认删了 Step 1 两文件后**仅剩 `atoms/assistant-panel.ts` 里的声明**(无消费者)。是则从 `apps/web-agent/src/atoms/assistant-panel.ts` 删除 `assistantPanelTypeAtom` 与 `previewPanelWidthAtom` 两个 atom 的声明及其上方 JSDoc。若仍有消费者,停止上报。

- [ ] **Step 3:✦ 顶栏按钮打开即选中随手问**

`apps/web-agent/src/components/shell/shell-top-bar.tsx`:✦ 按钮当前只 toggle `assistantPanelOpenAtom`。改为打开时同时把右区选中 tab 设为随手问——import `selectedContextTabAtom`(`@/atoms/right-zone`),在按钮 onClick 里当从关→开时额外 `setSelectedContextTab("quick")`。(保持 toggle 语义:开→关不变;关→开时设 quick。)

- [ ] **Step 4:artifact-fullscreen 头对齐 52px**

`apps/web-agent/src/components/artifact/artifact-fullscreen.tsx:42`(全屏标题栏)`h-11` → `h-13`。

- [ ] **Step 5:陈旧注释 + ToolsPanel useMemo**

`apps/web-agent/src/hooks/use-auto-open-artifact.ts`:删/改提到 `assistantPanelTypeAtom` 的陈旧注释(该 atom 已删)。
`apps/web-agent/src/components/session/tools-panel.tsx`:把每次读 `currentAssistantToolCallsAtom` 后的渲染用 `useMemo` 或直接用 atom 值(atom 已是稳定引用,若已无额外派生则跳过——如无 per-render 重算则本步 no-op,记录即可)。

- [ ] **Step 6:typecheck + build + 围栏**

Run:`pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`(timeout 600000)。再 `pnpm check`。Expected:全绿(删代码后 `check:dead` 跳过 apps/web-* 不受影响)。

- [ ] **Step 7:提交**

```bash
git add -A
git commit -m "refactor(web-agent): 清 P2b 遗留(死代码/✦按钮/全屏头/注释)

删死代码 ArtifactPreviewPanel/DockTabs + 孤儿 atom assistantPanelTypeAtom/previewPanelWidthAtom;
✦ 顶栏按钮打开即选中随手问 tab;artifact-fullscreen 头 52px;清陈旧注释。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾
- [ ] **Step 1:全量围栏** — `pnpm typecheck && pnpm check`;Expected 全绿。
- [ ] **Step 2:浅+深双模式整体冒烟**(人工)——两侧栏、选中态、hover、骨架、右区随手问、产物预览(ArtifactBody 在右区 tab)均正常;无 Slack 深侧栏残留。

---

## Self-Review
**1. 意图覆盖**:落法 A(深rail+暖米侧栏+白内容)✅(T1);选中白卡 ✅(T1-S3);主题翻转靠 token 不写死 ✅(映射表);死代码/✦/全屏头/注释清理 ✅(T2)。P3/P4/P5、产物全屏恢复不在本期。
**2. 占位符**:token 值、映射表、逐处 active 编辑均给确切内容;T2-S5 的 useMemo 显式允许"若无重算则 no-op"。
**3. 一致**:`--shell-sidebar-fg`/`-hover`/`-border` 三 token 在 design(浅深)与 7 组件引用一致;选中白卡 `bg-(--shell-content)` 浅深自动翻;T1 token+组件同提交避免中间破态。
**4. 风险**:T1 是原子大改(token+7 组件),中间态不可分——故单提交 + 浅/深双冒烟强制。深色仅新增 3 token、侧栏底不变,回归面小。
