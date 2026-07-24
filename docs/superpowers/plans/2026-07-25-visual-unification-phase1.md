# 视觉统一第一段（token 层 + 门面页）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把落地页的硬边质感下沉为 `packages/design` 共享 token 与工具类，并完成双端门面页（登录/注册/授权/onboarding）的落地页化。

**Architecture:** 圆角档位表从乘法派生改显式硬边值（一处改动全局收紧，无需改类名）；Button 新增 `brand` variant 收敛现有 ad-hoc 橙色覆盖类；`mb-*` 签名工具类 opt-in。落地页 `--lp-*` 不动。

**Tech Stack:** Tailwind v4 `@theme inline` · CVA · next-intl · Playwright MCP（截图验收）

**Spec:** `docs/superpowers/specs/2026-07-25-visual-unification-design.md`

## Global Constraints

- 圆角目标值（spec §三，逐字）：`--radius-sm: 2px` / `--radius-md: 2px` / `--radius-lg: 4px` / `--radius-xl: 6px` / `--radius-2xl~4xl: 6px` / `--shell-radius: 4px`；`rounded-full` 不动
- 眉标签小字对比度：亮色用 `#a83b07`（落地页 `--lp-brand-lt`，10px 小字 AA）；暗色用 `var(--brand)`
- `mb-eyebrow` 文案必须走 next-intl（`i18n-page` 技能），zh/en 同值（等宽英文是视觉签名）
- 禁改：`apps/web-main/src/components/landing/**`（落地页是基准）
- 高密度工作区不加纹理；本段只动门面页
- 每次代码变更后跑 Biome（`biome-format` 技能）；提交信息中文 conventional commits
- 工作分支：`feat/visual-unification`（已建，spec 已在其上）

---

### Task 1: design 包基础层（圆角档位 + brand variant + mb-* 工具类）+ 壳点阵

**Files:**
- Modify: `packages/design/src/styles/globals.css:28-34`（档位表）、`:49`（--radius）、`:68`（--shell-radius）、文件尾（mb-* 工具类）
- Modify: `packages/design/src/components/ui/button.tsx:11-22`（variants）
- Modify: `packages/web-common/src/shell/pre-login-shell.tsx:25`（加点阵）

**Interfaces:**
- Produces: `Button variant="brand"`（橙底白字）；CSS 类 `mb-eyebrow` / `mb-dots` / `mb-glow` / `mb-hairline-grid`；全局收紧后的 `rounded-*` 档位

- [ ] **Step 1: 改圆角档位表**

`packages/design/src/styles/globals.css` 第 28-34 行，替换为：

```css
  --radius-sm: 2px;
  --radius-md: 2px;
  --radius-lg: 4px;
  --radius-xl: 6px;
  --radius-2xl: 6px;
  --radius-3xl: 6px;
  --radius-4xl: 6px;
```

第 68 行 `--shell-radius: 0.5rem;` 改为 `--shell-radius: 4px;`。第 49 行 `--radius: 0.5rem;` **保留**（先查消费者再决定去留，见 Step 2）。

- [ ] **Step 2: 查 `var(--radius)` 残余消费者**

Run: `grep -rn "var(--radius)" packages apps --include="*.tsx" --include="*.css" | grep -v node_modules | grep -v landing`
若有组件直接消费 `var(--radius)`（绕过档位表），把该处改为对应档位 token（按钮/输入 `--radius-md`、卡片 `--radius-xl`）；若无消费者，把第 49 行 `--radius` 一并删除。

- [ ] **Step 3: Button 加 brand variant**

`packages/design/src/components/ui/button.tsx` 的 `variant` 对象内、`link` 行后加：

```ts
        brand:
          "bg-(--brand) text-white shadow hover:bg-(--brand-hover)",
```

- [ ] **Step 4: 加 mb-* 工具类**

`packages/design/src/styles/globals.css` 文件尾追加：

```css
/* ── MeshBot 签名元素（落地页质感下沉，opt-in；spec 2026-07-25-visual-unification）── */
.mb-eyebrow {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  letter-spacing: 0.19em;
  text-transform: uppercase;
  /* 10px 小字：亮色用压深橙保 AA（对齐落地页 --lp-brand-lt） */
  color: #a83b07;
}
.dark .mb-eyebrow {
  color: var(--brand);
}
.mb-dots {
  background-image: radial-gradient(circle, rgba(210, 74, 13, 0.1) 1px, transparent 1px);
  background-size: 23px 23px;
}
.dark .mb-dots {
  background-image: radial-gradient(circle, rgba(210, 74, 13, 0.14) 1px, transparent 1px);
}
.mb-glow {
  background: radial-gradient(closest-side, rgba(210, 74, 13, 0.08), transparent);
}
.mb-hairline-grid > * + * {
  border-top: 1px solid var(--border);
}
```

- [ ] **Step 5: PreLoginShellView 加点阵**

`packages/web-common/src/shell/pre-login-shell.tsx` 第 26-32 行的背景容器，在两团柔光 div 之前加一层点阵（放最底层）：

```tsx
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="mb-dots absolute inset-0 opacity-60" />
        <div className="absolute -top-24 -left-16 h-80 w-80 rounded-full bg-(--shell-accent)/4 blur-2xl" />
        <div className="absolute -bottom-32 -right-12 h-96 w-96 rounded-full bg-(--shell-accent)/3 blur-2xl" />
      </div>
```

- [ ] **Step 6: 验证**

Run: `pnpm format && pnpm typecheck`
Expected: typecheck 27/27 通过。
Run: `grep -n "radius-sm: 2px" packages/design/src/styles/globals.css && grep -n "brand:" packages/design/src/components/ui/button.tsx`
Expected: 两处都命中（确认改动真实落地）。

- [ ] **Step 7: Commit**

```bash
git add packages/design packages/web-common
git commit -m "feat(design): 圆角档位收紧至落地页硬边档，新增 brand 按钮与 mb-* 签名工具类"
```

---

### Task 2: web-main 门面页落地页化（login / register / authorize / onboarding）

**Files:**
- Modify: `apps/web-main/src/app/login/page.tsx`、`register/page.tsx`、`authorize/page.tsx`、`onboarding/page.tsx`、`apps/web-main/src/components/auth/org-onboarding.tsx`（若其内有橙色覆盖按钮）
- Modify: `apps/web-main/messages/zh.json`、`en.json`（eyebrow key）

**Interfaces:**
- Consumes: Task 1 的 `variant="brand"`、`mb-eyebrow`
- Produces: i18n key `login.eyebrow` / `register.eyebrow` / `authorize.eyebrow` / `onboarding.eyebrow`

- [ ] **Step 1: 收敛 ad-hoc 橙色按钮为 brand variant**

Run: `grep -rn "bg-(--shell-accent) text-white hover:bg-(--shell-accent-hover)" apps/web-main/src`
对每一处命中（已知 login/page.tsx:112、register/page.tsx:237、register/page.tsx:298，authorize/onboarding 以 grep 结果为准）做同一替换——例（login）：

```tsx
// 旧
<Button
  type="submit"
  className="mt-2 h-11 w-full rounded-xl bg-(--shell-accent) text-white hover:bg-(--shell-accent-hover)"
  disabled={loginMutation.isPending}
>
// 新
<Button
  type="submit"
  variant="brand"
  className="mt-2 h-11 w-full"
  disabled={loginMutation.isPending}
>
```

要点：删掉 `rounded-xl`（按钮走 `rounded-md`=2px 档）与三个颜色类，保留布局类（`mt-* h-11 w-full`）。

- [ ] **Step 2: 标题区加眉标签、标题加重**

login/page.tsx 第 58-69 行的标题区，`welcomeBack` 小字行替换为眉标签，标题加重：

```tsx
          <div className="space-y-0 pb-4">
            <p className="mb-eyebrow mb-2 text-center">{t("eyebrow")}</p>
            <h1 className="text-center text-[28px] leading-[1.15] font-extrabold tracking-[-0.03em] text-foreground">
              {t("title")}
            </h1>
            <p className="mt-1 text-center text-[12px] tracking-[0.08em] text-muted-foreground">
              {t("subtitle")}
            </p>
          </div>
```

register / authorize / onboarding 的 `<h1>`（或等价标题）用同一模式：紧邻标题上方插 `<p className="mb-eyebrow mb-2 text-center">{t("eyebrow")}</p>`，标题类中 `font-semibold` → `font-extrabold`、`tracking-tight` → `tracking-[-0.03em]`。多步骤页（register 的 verify 步等）眉标签只加在每步的主标题上。

- [ ] **Step 3: i18n key**

`apps/web-main/messages/zh.json` 与 `en.json`，在对应 namespace 加（zh/en 同值）：

```json
"login":     { "eyebrow": "SIGN IN" }
"register":  { "eyebrow": "CREATE ACCOUNT" }
"authorize": { "eyebrow": "AUTHORIZE DEVICE" }
"onboarding":{ "eyebrow": "GET STARTED" }
```

Run: `pnpm sync:locales -- --check`
Expected: `missing=0, asymmetric=0`（orphan 列表可忽略；若 `welcomeBack` 变 orphan 可顺手删 key）。

- [ ] **Step 4: 验证 + Commit**

Run: `pnpm format && pnpm typecheck && pnpm dev:web-main`，浏览器过一遍 /login /register /authorize /onboarding（此时应看到：6px 卡、2px 输入框与按钮、眉标签、点阵背景）。

```bash
git add apps/web-main
git commit -m "feat(web-main): 门面页落地页化——眉标签、brand 按钮、标题加重"
```

---

### Task 3: web-agent 登录页同步（可与 Task 2 并行，文件集不重叠）

**Files:**
- Modify: `apps/web-agent/src/app/login/page.tsx`（292 行，两处 `<h1>`：:160、:194）
- Modify: `apps/web-agent/src/locales/zh.json` 与 en（key 路径以仓内实际为准，`pnpm sync:locales -- --write` 补 stub 后填值）

**Interfaces:**
- Consumes: Task 1 的 `variant="brand"`、`mb-eyebrow`

- [ ] **Step 1: 同模式改造**

与 Task 2 相同的三个动作应用到 web-agent 登录页：
1. `grep -n "bg-(--shell-accent) text-white" apps/web-agent/src/app/login/page.tsx`，命中的按钮改 `variant="brand"` 并删颜色/圆角覆盖类
2. 两处 `<h1 className="text-[22px] font-extrabold tracking-tight">`（:160、:194）上方各插 `<p className="mb-eyebrow mb-2">{t("eyebrow")}</p>`（该页已是 extrabold，只加眉标签；`tracking-tight` → `tracking-[-0.03em]`）
3. eyebrow key 值 `SIGN IN`，zh/en 同值；新增嵌套 t() 后跑 `pnpm sync:locales -- --write` 补另一侧 stub 再填值

- [ ] **Step 2: 验证 + Commit**

Run: `pnpm format && pnpm typecheck && pnpm sync:locales -- --check`
Run: `pnpm dev:server-agent` + `pnpm dev:web-agent`，浏览器开 http://localhost:3101/login 目检（登出态）。
注意 `boot-verify-leaks-port-7727` 教训：目检完杀掉临时 server-agent，勿留幽灵进程占 7727。

```bash
git add apps/web-agent
git commit -m "feat(web-agent): 登录页同步落地页质感——眉标签与 brand 按钮"
```

---

### Task 4: 验收回归（截图 × 双主题 × 三断点 + 副作用抽查 + 变异抽查）

**Files:** 无代码改动（发现异常则单独小修并入本任务提交）

- [ ] **Step 1: 变异抽查（确认档位表真在管圆角）**

把 `--radius-md: 2px` 临时改为 `12px`，`grep -n "radius-md" packages/design/src/styles/globals.css` 打印确认变异落地，刷新 /login 截图确认按钮明显变圆；还原后再 grep 确认还原、再截图确认回到 2px。两次都要看文件实际内容（本仓铁律：变异未落地就下结论是真实事故）。

- [ ] **Step 2: 门面页截图矩阵**

Playwright MCP 依次截图（`browser_resize` 375/768/1440 × 亮暗两主题，主题用页内切换或 `document.documentElement.classList.toggle("dark")`）：
- web-main：`/login` `/register` `/authorize` `/onboarding`（3102）
- web-agent：`/login`（3101）

检查点：卡 6px / 按钮输入框 2px / 眉标签等宽橙字 / 点阵可见但不喧宾 / 暗色下眉标签用 `--brand` 可读。

- [ ] **Step 3: token 副作用抽查（全局收紧殃及的页面）**

登录后截图：web-main 会话页 + 设置；web-agent 会话页 + IM + 设置（亮暗各一）。抓「大圆角假设」异常：开关（Switch，应仍 `rounded-full`）、进度条、气泡、头像。发现异常组件：`rounded-full` 类的不该受影响；受档位表影响且难看的，在该组件上加显式 `rounded-[Npx]` 豁免并记录到提交信息。

- [ ] **Step 4: 全量围栏 + 收尾**

Run: `pnpm lint && pnpm typecheck && pnpm check && pnpm sync:locales -- --check && pnpm test && pnpm build`
Expected: 全绿（libs/agent vitest 基线失败按记忆 `libs-agent-vitest-baseline-failures` 对照，判回归先减基线）。
web-agent 若跑过 build：按记忆 `web-agent-build-pollutes-dev` 清 `.next`（别删 `out`）。

```bash
git add -A
git commit -m "fix(ui): 视觉统一第一段验收回归中的豁免与微调"   # 仅当 Step 3 有修改时
```

- [ ] **Step 5: 交付点**

汇总截图给用户真机验收。**验收通过前不规划第二段、不开 PR。**

---

## Self-Review 记录

- Spec 覆盖：§三 token 层 → Task 1；§四门面页五项 → Task 2/3（AuthCard 圆角与阴影随 token 自动收敛，无需改文件，spec §四.1 由 Task 1 实现）；§六验收 → Task 4。无缺口。
- 占位符扫描：register/authorize/onboarding 未逐行贴 diff，但给了精确 grep 枚举命令 + 完整替换代码模式，可独立执行；无 TBD。
- 类型一致性：`variant="brand"` 与 Task 1 CVA 定义一致；`mb-eyebrow`/`mb-dots` 类名各任务一致。
