# UI P5 登录前重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把两端（web-agent 本地桌面 / web-main 云端网页）的**登录前**界面从"左品牌渐变块 + 右表单"分屏，重构为**对话式居中单列**、套统一暖炭·配橙视觉语言，共用一个 `PreLoginShellView` 展示壳。

**Architecture:** 纯 UI 套皮（**零后端改动**）。新增共享 `PreLoginShellView`（web-common/shell，纯展示，仿 `PageShellView` 容器/视图拆分）；两端各自的登录页/壳作薄容器注入自己的 chrome（web-agent 注入 Electron 拖拽栏 + 主题/语言切换；web-main 注入语言切换或留空）与数据。web-agent 复用既有设备授权链路 `startAuthorize`/`pollAuthorize`/`completeAuthorize`；web-main 复用既有邮箱+验证码 login/register/verify + 设备授权确认页 `/authorize`。

**Tech Stack:** Next.js 15 App Router · Tailwind v4（`@source` 扫描 + `bg-(--var)` 任意值）· next-intl · `@meshbot/web-common/shell`（源码直连子路径）· `@meshbot/design`。

## Global Constraints

- **设计定稿**：spec `docs/superpowers/specs/2026-07-04-unified-ui-redesign-design.md` §5（登录前）+ §6（视觉 token）；批准的 mockup：`.superpowers/brainstorm/5396-1783157393/content/prelogin-A-deviceauth.html`（两态：初始 + 授权中）。
- **落法 = 纯 UI 套皮（用户拍板 Option A）**：**不做本机配对码**（当前后端的 `userCode` 是浏览器端批准后才生成，方向与 mockup 相反，实现它需改后端安全流程——本期不做）。web-agent 手动输码保留为**折叠兜底**。
- **配色克制铁律**：焦橙 `--brand`/`--shell-accent`=`#d24a0d` 只出现在"强调 / 主按钮 / 我方 / 流式"；绿只表在线/本机。主按钮统一用 `ACCENT_BTN`（web-agent `@/lib/ui`）或等价 accent 类。
- **真实 token（design globals.css `:root`）**：`--brand:#d24a0d` `--brand-hover:#b03d0a` `--shell-chrome:#241c15` `--shell-sidebar:#f0e8de` `--shell-sidebar-fg:#241c15` `--shell-sidebar-border:#e6ded4` `--shell-content:#ffffff` `--shell-accent:var(--brand)` `--shell-accent-hover:var(--brand-hover)`。`--background` 是白（oklch(1 0 0)），**不是**暖底——暖页面底用本计划新增的 `--surface-0`。
- **形制**：圆角 10–14px（`rounded-xl`/`rounded-[14px]`）；1px 暖边 `--shell-sidebar-border`；极浅阴影 `shadow-sm`。密度接近 Linear/Notion，但表面暖米不冷灰。
- **品牌**：用共享 `BrandLogo`（`@meshbot/web-common/shell`，支持 `size` + `withWordmark`）。
- **字体**：Hanken Grotesk（P1 已自托管，`--font-sans`），无需改。
- **i18n**：zh + en 对称；新增 key 后跑 `pnpm --filter <app> ...` 前先 `pnpm sync:locales --write` 补 en stub 再填英文；提交前 pre-commit 的 `sync-locales --check` 必须 `missing=0 asymmetric=0`（孤儿是 warning、不阻断）。
- **验证**：无前端组件测试运行器（web-agent/web-main 无 jest/RTL）；web-common jest 仅 node（测纯函数，不测 JSX）。故每个任务验证 = `pnpm --filter <app> typecheck` + `pnpm --filter <app> build`（Tailwind `@source` 类生成）+ **人工视觉冒烟**。
- **不改后端 / 不改数据层**：只动展示层文件（列在各任务 Files）。禁止碰 `rest/*.ts`、`server-*`、DDL。
- 分支：接续当前 `feat/ui-p3a-shared-leaves`（P3/P4 所在分支）。中文 conventional commits，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

## 前置事实（实现者须知，勿假设）

- **web-agent 设备授权流程**（复用，勿改）：`startAuthorize()`→`{requestId, authorizeUrl}`，前端 `window.open(authorizeUrl)`；`pollAuthorize(requestId)`→`{status:"pending"}` | `{status:"done", access_token}`；`completeAuthorize(code)`→`LoginResponse`（手动兜底）。登录成功 `applyAuthToken(token)` + `router.replace("/")`。全在 `apps/web-agent/src/rest/auth.ts`（**不改**）。
- **web-agent 登录页现状**：`apps/web-agent/src/app/login/page.tsx`（用 `AuthShellLayout` + `Card`；stage: idle/waiting/timeout + 折叠手动输码）。全部状态机逻辑（`beginPolling`/`clearTimers`/`finishLogin`/`onBrowserLogin`/`onCancelWaiting`/`onManualSubmit` + 三个 ref + 卸载清理 effect）**逐字保留**，只换渲染层。
- **web-main 授权确认页**：`apps/web-main/src/app/authorize/page.tsx`（多态：确认卡/已批准/错误/OrgOnboarding），用 `AuthShell`。逻辑不改，只让它继承新壳视觉。
- **两端 globals.css 已 `@source "…/web-common/src/shell"`**（rail 已消费 BrandLogo/RailNavItem 证明生效）。实现 Task 1 后无需再改 @source。若 build 后新组件 class 丢失，检查该行是否存在。
- **BrandLogo**（`packages/web-common/src/shell/brand-logo.tsx`）：props `size?: "sm"|"md"|"lg"` + `withWordmark?: boolean` + `className?`。已在 rail/AuthShellLayout 使用。

---

## Task 1: 暖底 token + 共享 `PreLoginShellView`

**Files:**
- Modify: `packages/design/src/styles/globals.css`（`:root` 加 `--surface-0`；`.dark` 加暗值）
- Create: `packages/web-common/src/shell/pre-login-shell.tsx`
- Modify: `packages/web-common/src/shell/index.ts`（barrel 导出）

**Interfaces:**
- Produces: `PreLoginShellView`（纯展示居中单列壳）+ `PreLoginShellViewProps`：
  ```ts
  interface PreLoginShellViewProps {
    /** 顶部整宽条（web-agent 注入 <DragRegion actions=…/>；web-main 可注入语言切换行或留空）。 */
    topBar?: ReactNode;
    /** 居中单列内容（品牌 + 标题 + 表单/按钮 + 脚注），容器已给 max-w + 居中 + 暖底。 */
    children: ReactNode;
    /** 覆盖内容列宽/间距默认（默认 max-w-[360px] gap-5 text-center）。 */
    className?: string;
  }
  ```

- [ ] **Step 1: 加暖底 token**

在 `packages/design/src/styles/globals.css` 的 `:root` 块内、`--shell-accent-hover: var(--brand-hover);` 之后加：

```css
  --surface-0: #faf7f2;
```

在 `.dark` 块内、其 `--shell-*` 暗值附近加（沿用暖炭·非纯灰）：

```css
  --surface-0: oklch(0.17 0.008 55);
```

- [ ] **Step 2: 写 `PreLoginShellView`**

`packages/web-common/src/shell/pre-login-shell.tsx`：

```tsx
"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

export interface PreLoginShellViewProps {
  /** 顶部整宽条（web-agent 注入拖拽栏 + 切换；web-main 可留空或注入语言切换）。 */
  topBar?: ReactNode;
  /** 居中单列内容（品牌 + 标题 + 表单/按钮 + 脚注）。 */
  children: ReactNode;
  /** 覆盖内容列默认 class（宽度/间距/对齐）。 */
  className?: string;
}

/**
 * 登录前对话式壳（纯展示）：暖底整屏 + 顶部可选整宽条 + 居中单列内容。
 * 两端共用：各 app 薄容器注入自己的 topBar（拖拽栏/切换）与内容。
 */
export function PreLoginShellView({
  topBar,
  children,
  className,
}: PreLoginShellViewProps) {
  return (
    <div className="relative flex min-h-screen flex-col bg-(--surface-0) text-(--shell-sidebar-fg)">
      {topBar}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
        <div
          className={cn(
            "flex w-full max-w-[360px] flex-col items-center gap-5 text-center",
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: barrel 导出**

`packages/web-common/src/shell/index.ts` 加一行（保持字母序，插在 `PageShellView` 后、`RailNavItem` 前）：

```ts
export { PreLoginShellView, type PreLoginShellViewProps } from "./pre-login-shell";
```

- [ ] **Step 4: typecheck web-common**

Run: `pnpm --filter @meshbot/web-common typecheck`
Expected: exit 0（若无该脚本则 `pnpm --filter @meshbot/web-common exec tsc --noEmit`）。

- [ ] **Step 5: Commit**

```bash
git add packages/design/src/styles/globals.css packages/web-common/src/shell/pre-login-shell.tsx packages/web-common/src/shell/index.ts
git commit -m "feat(web-common): 登录前对话式壳 PreLoginShellView + 暖底 --surface-0 token"
```

---

## Task 2: web-agent 登录页对话式重构

**Files:**
- Modify: `apps/web-agent/src/components/layouts/auth-shell-layout.tsx`（分屏 → 用 `PreLoginShellView`，保留 Electron chrome）
- Modify: `apps/web-agent/src/app/login/page.tsx`（渲染层换对话式两态，逻辑逐字保留）
- Modify: `apps/web-agent/messages/zh.json` + `apps/web-agent/messages/en.json`（`login` 新增文案 key）

**Interfaces:**
- Consumes: `PreLoginShellView`（Task 1）；`BrandLogo`；`ACCENT_BTN`（`@/lib/ui`）；`startAuthorize`/`pollAuthorize`/`completeAuthorize`/`applyAuthToken`（`@/rest/auth`，不改）。

- [ ] **Step 1: 重构 `AuthShellLayout` 为对话式 chrome 容器**

把 `apps/web-agent/src/components/layouts/auth-shell-layout.tsx` 改为：保留 `DragRegion` + 主题/语言切换（放进 `topBar`），删除左品牌渐变块，body 交给 `PreLoginShellView`。`brandTagline`/`brandSubtitle` 不再由壳渲染（移到登录页初始态文案，见 Step 3）。

```tsx
"use client";

import { useTheme } from "@meshbot/web-common/react";
import { PreLoginShellView } from "@meshbot/web-common/shell";
import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { DragRegion } from "@/components/drag-region";
import { LanguageToggle } from "@/components/language-toggle";

interface AuthShellLayoutProps {
  children: React.ReactNode;
  className?: string;
}

/** 登录前 chrome 容器：注入 Electron 拖拽栏 + 主题/语言切换，body 走对话式单列壳。 */
export function AuthShellLayout({ children, className }: AuthShellLayoutProps) {
  const [mounted, setMounted] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const tCommon = useTranslations("common");

  useEffect(() => {
    document.body.classList.add("auth-shell-mode");
    setMounted(true);
    return () => {
      document.body.classList.remove("auth-shell-mode");
    };
  }, []);

  return (
    <PreLoginShellView
      className={className}
      topBar={
        <DragRegion
          actions={
            <div className="flex items-center gap-2">
              <LanguageToggle />
              <button
                type="button"
                onClick={toggleTheme}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-(--shell-sidebar-border) text-(--shell-sidebar-fg)/70 transition-colors hover:bg-(--shell-sidebar-hover)"
                title={
                  theme === "dark"
                    ? tCommon("switchToLightTheme")
                    : tCommon("switchToDarkTheme")
                }
              >
                {theme === "dark" ? (
                  <Sun className="h-3.5 w-3.5" />
                ) : (
                  <Moon className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          }
        />
      }
    >
      {mounted ? children : null}
    </PreLoginShellView>
  );
}
```

- [ ] **Step 2: 加 i18n 文案 key（zh）**

`apps/web-agent/messages/zh.json` 的 `login` 块内新增/改这些 key（保留现有 manual*/cancel/timeoutMessage/noAccount/goRegister/starting/startFailed/manualFailed/validation）：

```jsonc
// login 块内
"deviceHeadline": "开始和你的 Agent 协作",
"deviceSubtitle": "授权这台设备，你的 Agent 就在本机待命",
"browserLoginButton": "用浏览器授权本机",
"footNote": "会打开浏览器完成确认 · 全程不填密码",
"waitingHeadline": "已在浏览器打开授权页",
"waitingSub": "确认后自动进入",
"reopen": "没弹出？重新打开授权页"
```

（`waitingText`/`waitingHint`/`welcomeBack`/`title`/`subtitle`/`brandTagline`/`brandSubtitle` 若不再被引用会成孤儿——孤儿不阻断，本步不必删，Task 收尾统一评估。）

- [ ] **Step 3: 重写登录页渲染层**

`apps/web-agent/src/app/login/page.tsx`：**第 41–142 行的逻辑区（state/ref/effect/finishLogin/beginPolling/onBrowserLogin/onCancelWaiting/onManualSubmit/registerHref）逐字保留**，只替换 `return (...)`（第 144–268 行）为对话式两态。导入去掉 `Card*`，保留 `Alert*`/`Button`/`Input`/`Form`/`FormItem`/`Loader2`/`ChevronDown`；新增 `BrandLogo`（`@meshbot/web-common/shell`）。`onBrowserLogin` 复用为"重新打开授权页"（waiting 态点 reopen 再调一次）。

新 `return`：

```tsx
  return (
    <AuthShellLayout>
      <BrandLogo size="md" withWordmark />

      {stage === "waiting" ? (
        <>
          <h1 className="text-[22px] font-extrabold tracking-tight">
            {t("waitingHeadline")}
          </h1>
          <p className="-mt-2 text-[12.5px] text-(--shell-sidebar-fg)/60">
            {t("waitingSub")}
          </p>
          <div className="flex items-center gap-2 text-[12px] text-(--shell-sidebar-fg)/70">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-(--shell-accent)" />
            {t("waitingText")}
          </div>
          <button
            type="button"
            onClick={onBrowserLogin}
            disabled={starting}
            className="text-[11px] text-(--shell-sidebar-fg)/55 hover:text-(--shell-accent)"
          >
            {t("reopen")}
          </button>
          <button
            type="button"
            onClick={onCancelWaiting}
            className="text-[11px] text-(--shell-sidebar-fg)/45 hover:text-(--shell-sidebar-fg)"
          >
            {t("cancel")}
          </button>
        </>
      ) : (
        <>
          <h1 className="text-[22px] font-extrabold tracking-tight">
            {t("deviceHeadline")}
          </h1>
          <p className="-mt-2 text-[12.5px] text-(--shell-sidebar-fg)/60">
            {t("deviceSubtitle")}
          </p>
          {stage === "timeout" && (
            <Alert variant="destructive" className="text-left">
              <AlertDescription>{t("timeoutMessage")}</AlertDescription>
            </Alert>
          )}
          {startError && (
            <Alert variant="destructive" className="text-left">
              <AlertDescription>{startError}</AlertDescription>
            </Alert>
          )}
          <Button
            type="button"
            className={`h-12 w-full max-w-[300px] rounded-[14px] text-[13px] ${ACCENT_BTN}`}
            disabled={starting}
            onClick={onBrowserLogin}
          >
            {starting ? t("starting") : t("browserLoginButton")}
          </Button>
          <p className="text-[10.5px] leading-relaxed text-(--shell-sidebar-fg)/45">
            {t("footNote")}
          </p>
        </>
      )}

      {/* 手动输码：折叠兜底（loopback 失败 / 无回环场景） */}
      <div className="w-full max-w-[300px]">
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1 text-[11px] text-(--shell-sidebar-fg)/45 hover:text-(--shell-sidebar-fg)"
          onClick={() => setManualOpen((v) => !v)}
          aria-expanded={manualOpen}
        >
          {t("manualToggle")}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${manualOpen ? "rotate-180" : ""}`}
          />
        </button>
        {manualOpen && (
          <Form
            schema={manualSchema}
            defaultValues={{ code: "" }}
            onSubmit={onManualSubmit}
            disabled={manualSubmitting}
            className="mt-3 flex flex-col gap-3 text-left"
          >
            <FormItem name="code" label={t("manualLabel")}>
              <Input
                autoComplete="one-time-code"
                placeholder={t("manualPlaceholder")}
              />
            </FormItem>
            {manualError && (
              <Alert variant="destructive">
                <AlertDescription>{manualError}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" variant="outline" disabled={manualSubmitting}>
              {manualSubmitting ? t("manualSubmitting") : t("manualSubmit")}
            </Button>
          </Form>
        )}
      </div>

      {registerHref ? (
        <p className="text-[11px] text-(--shell-sidebar-fg)/45">
          {t("noAccount")}{" "}
          <a
            href={registerHref}
            target="_blank"
            rel="noreferrer"
            className="text-(--shell-accent) hover:underline"
          >
            {t("goRegister")}
          </a>
        </p>
      ) : null}
    </AuthShellLayout>
  );
```

- [ ] **Step 4: 补 en stub 并填英文**

Run: `pnpm sync:locales --write`
然后在 `apps/web-agent/messages/en.json` 的 `login` 块填英文：`deviceHeadline`="Start working with your Agent"、`deviceSubtitle`="Authorize this device and your Agent stands by locally"、`browserLoginButton`="Authorize this device in browser"、`footNote`="Opens your browser to confirm · never asks for a password"、`waitingHeadline`="Authorization page opened in your browser"、`waitingSub`="You'll be signed in automatically"、`reopen`="Didn't open? Reopen the authorization page"。

- [ ] **Step 5: typecheck + build**

Run: `pnpm --filter web-agent typecheck` → exit 0
Run: `pnpm --filter web-agent build` → 成功（确认无 Tailwind 缺类 / 无 SSR 报错）

- [ ] **Step 6: Commit**

```bash
git add apps/web-agent/src/components/layouts/auth-shell-layout.tsx apps/web-agent/src/app/login/page.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): 登录前重构为对话式设备授权单列（复用授权链路，纯套皮）"
```

---

## Task 3: web-main 登录/注册/授权套皮

**Files:**
- Modify: `apps/web-main/src/components/auth/auth-shell.tsx`（分屏 → `PreLoginShellView` + 顶部品牌）
- Modify: `apps/web-main/src/app/login/page.tsx`（去 Card 分栏残留，主按钮 accent，品牌在壳顶）
- Modify: `apps/web-main/src/app/register/page.tsx`（同上：主按钮 accent、贴合居中单列）
- Modify: `apps/web-main/messages/zh.json` + `en.json`（如需微调文案）

**Interfaces:**
- Consumes: `PreLoginShellView`（Task 1）；`BrandLogo`。复用既有 `useLogin`/`useRegister`/`useVerify` 数据钩子与 `authorize/page.tsx` 逻辑（**不改**）。

- [ ] **Step 1: 重构 `AuthShell`**

`apps/web-main/src/components/auth/auth-shell.tsx` 改为对话式：删左品牌渐变块，用 `PreLoginShellView`，把 `BrandLogo` 放到内容列顶部（所有子页共享品牌头），保留 `className` 透传。

```tsx
"use client";

import { cn } from "@meshbot/design";
import { BrandLogo, PreLoginShellView } from "@meshbot/web-common/shell";

interface AuthShellProps {
  children: React.ReactNode;
  className?: string;
}

/** 云端登录前壳：对话式居中单列 + 顶部品牌，套统一暖炭·配橙视觉语言。 */
export function AuthShell({ children, className }: AuthShellProps) {
  return (
    <PreLoginShellView className={cn("max-w-[380px]", className)}>
      <BrandLogo size="md" withWordmark />
      {children}
    </PreLoginShellView>
  );
}
```

> 注：`authShell.brand/tagline/subtitle` 三个 key 就此不再被壳引用（成孤儿，不阻断）。子页各自的 Card 标题/描述继续用自己的 `login`/`register`/`authorize` 文案。

- [ ] **Step 2: 登录页贴合居中单列**

`apps/web-main/src/app/login/page.tsx`：`AuthShell` 现在已给品牌 + 居中列。把内层 `<Card border-0 shadow-none>` 保留但确保内容**居中且无重复品牌**；标题/描述用 `text-center`；主"登录"按钮加 accent class（与 web-agent 一致的观感）：给提交 Button 追加 `className="h-11 w-full rounded-xl bg-(--shell-accent) text-white hover:bg-(--shell-accent-hover)"`。`goRegister`/链接色改 `text-(--shell-accent)`。不改任何表单逻辑 / schema / 提交回调。

- [ ] **Step 3: 注册页贴合居中单列**

`apps/web-main/src/app/register/page.tsx`：同 Step 2 处理——`text-center` 标题、主按钮 accent（`创建账号并继续` / `验证并继续` 两处提交按钮）、链接色 `--shell-accent`。多步（create / verify）壳不变，仅样式。逻辑/schema/`router.replace` 全不动。

- [ ] **Step 4: typecheck + build**

Run: `pnpm --filter web-main typecheck` → exit 0
Run: `pnpm --filter web-main build` → 成功
（`pnpm sync:locales --check` 由 pre-commit 跑；若删了文案 key 记得 zh/en 对称。）

- [ ] **Step 5: Commit**

```bash
git add apps/web-main/src/components/auth/auth-shell.tsx apps/web-main/src/app/login/page.tsx apps/web-main/src/app/register/page.tsx apps/web-main/messages/zh.json apps/web-main/messages/en.json
git commit -m "feat(web-main): 登录/注册/授权套对话式单列新皮（复用邮箱验证码链路）"
```

---

## 完成后（controller 负责）

- **人工视觉冒烟**（无自动组件测试）：
  - web-agent 登录：初始态（品牌 + "开始和你的 Agent 协作" + 主按钮 + 脚注）；点按钮 → 浏览器开 + 进 waiting 态（"已在浏览器打开授权页" + spinner + reopen + cancel）；折叠手动输码可展开提交；暗色/语言切换正常；Electron 拖拽栏可拖。
  - web-main 登录/注册/授权：居中单列 + 顶部品牌；主按钮焦橙；authorize 确认页多态（确认/已批准复制码/错误/建组织）视觉一致；暗色正常。
- 孤儿文案 key（`login.welcomeBack/title/subtitle/brandTagline/brandSubtitle`、`authShell.*` 等）统一评估删除（非阻断，可留 follow-up）。
- 终审：dispatch 全分支 code-reviewer（P5 delta + 整分支），Ready 后交由用户决定合 PR。
