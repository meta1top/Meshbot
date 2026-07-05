# UI 重构 P4a:web-main 用上统一壳(深 rail + 六项 + 占位) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 web-main 从"两套顶栏互跳布局(settings/messages)"换成和 web-agent 一样的**深 rail 三区壳**:六项 rail(真区 消息/设置 + 占位 助手/技能/网盘/流程)+ 头像菜单在 rail 底 + 主题。用 P3a-c 已备的共享积木(`RailNavItem`/共享 `BrandLogo`),连 web-main 自己的 react-query。

**Architecture:** web-main 现有 `/messages`、`/settings/*` 各自带顶栏的 layout,靠顶栏文字链接互跳、无 rail。P4a:①补基础(logo.svg + themeScript + `@source` 扫 web-common/shell,并把 `BrandLogo` 提升为共享);②建 web-main `WorkspaceRail`(深 rail,六项 `RailNavItem`,消息/设置 真跳、助手/技能/网盘/流程 跳占位空态页,主题切换 + `UserMenu` 在底);③建 `app/(shell)/layout.tsx` 持久壳(rail + 内容区),把 `/messages`、`/settings` 迁进 `(shell)` 组、去掉各自顶栏,加 4 个占位区页,首页重定向到 `/messages`。**暖米侧栏 token 共享自动继承;把 web-main 侧栏重排暖米浅 + 用 PageShellView 放 P4b。**

**Tech Stack:** Next.js 16(App Router,route group)· React 19 · react-query · `@meshbot/web-common`(useTheme/themeScript/shell)· Tailwind v4。

## Global Constraints

- **rail 六项(同 web-agent 顺序)**:助手 · 消息 · 技能 · 网盘 · 流程 · 设置。**真区**:消息(`/messages`)、设置(`/settings/org`)。**占位区**:助手/技能/网盘/流程 → 各自 `即将上线` 空态页。
- **深 rail + 暖米侧栏 = 与 web-agent 一致**:rail 用 `bg-(--shell-chrome)`;侧栏底色 token(`--shell-sidebar` 暖米)由 design 共享 globals 提供,web-main import 后自动继承(**本期不重排 web-main 侧栏内部,只让壳骨架统一;侧栏内部暖米化留 P4b**)。
- **共享积木**:rail 项用 `RailNavItem`(`@meshbot/web-common/shell`);`BrandLogo` 本期**提升为共享**(两端都用)。**web-main 必须加 `@source ".../web-common/src/shell"`**(否则 RailNavItem/BrandLogo 的 class 静默丢失——P3a 教训)。
- **数据各自**:web-main 用它的 react-query（`useProfile`/`useSwitchOrg`/`clearMainToken`,已在 `UserMenu`)+ `usePathname`/`useRouter`。不引 jotai。
- **主题**:web-main root 加 `themeScript`(`@meshbot/web-common`)+ `suppressHydrationWarning`;rail 主题按钮用 `useTheme`(`@meshbot/web-common/react`)。web-main 由此获得暗色(design `.dark` token 共享)。
- **web-main 已部署**:改的是它的整条导航 UX,**收尾必人工冒烟**(登录后 rail 六项、真区可跳、占位空态、切组织/登出、暗色)。
- **验证**:`pnpm --filter @meshbot/web-common typecheck` + `pnpm --filter @meshbot/web-agent typecheck`&`build`(BrandLogo 共享后)+ `pnpm --filter @meshbot/web-main typecheck`&`build` + 人工冒烟。
- 禁 `--no-verify`;中文 commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;分支 `feat/ui-p3a-shared-leaves`(P3+P4 同分支)。

## 依赖与命令
typecheck:各 `pnpm --filter @meshbot/<pkg> typecheck`。build:`pnpm --filter @meshbot/web-main build`(timeout 600000)。冒烟 `pnpm dev:web-main`(3002)。

---

## Task 1:web-main 壳基础 + BrandLogo 共享

**Files:**
- Create: `apps/web-main/public/logo.svg`(从 web-agent 复制)
- Create: `packages/web-common/src/shell/brand-logo.tsx`(BrandLogo 提升共享)、改 `packages/web-common/src/shell/index.ts`
- Modify: `apps/web-agent/src/components/brand-logo.tsx`(删,改从共享引)、web-agent 中 BrandLogo 消费者
- Modify: `apps/web-main/src/app/layout.tsx`(themeScript + suppressHydration)、`apps/web-main/src/app/globals.css`(@source)

- [ ] **Step 1:web-main 补 logo.svg**

```bash
cp apps/web-agent/public/logo.svg apps/web-main/public/logo.svg
```

- [ ] **Step 2:BrandLogo 提升共享(next/image → 普通 img)** — 把 `apps/web-agent/src/components/brand-logo.tsx` 搬到 `packages/web-common/src/shell/brand-logo.tsx`,**唯一改动:去掉 `next/image`,`<Image .../>` 换成普通 `<img .../>`**——因为 web-common 无 `next` 依赖(tsc 找不到 `next/image`),而原本就传 `unoptimized`(svg 不优化),`<img>` 等效。其余(`cn`(design)、SIZE、props、class 串)一字不改。即:删 `import Image from "next/image";`,把:

```tsx
        <Image
          src="/logo.svg"
          alt="MeshBot"
          width={s.img}
          height={s.img}
          unoptimized
          className={cn(spinning && "animate-[spin_1.4s_linear_infinite]")}
        />
```
改为:
```tsx
        {/* biome-ignore lint/nursery/noImgElement: 共享包无 next 依赖,svg 用普通 img(原本就 unoptimized 等效) */}
        <img
          src="/logo.svg"
          alt="MeshBot"
          width={s.img}
          height={s.img}
          className={cn(spinning && "animate-[spin_1.4s_linear_infinite]")}
        />
```
(`/logo.svg` 各 app public 都有;若 Biome 的 img 规则名不同,按实际报错的规则名写 ignore 注释,或 grep 现有 `noImgElement`/`useImageElement` 用法对齐。)在 `packages/web-common/src/shell/index.ts` 末尾加:

```ts
export { BrandLogo } from "./brand-logo";
```

- [ ] **Step 3:web-agent 改用共享 BrandLogo + 删本地**

`grep -rln "components/brand-logo\|BrandLogo" apps/web-agent/src | grep -v "components/brand-logo.tsx"` 找出所有消费者(rail、auth 壳、loading 等),把 `import { BrandLogo } from "@/components/brand-logo"` 改为 `import { BrandLogo } from "@meshbot/web-common/shell"`。然后 `git rm apps/web-agent/src/components/brand-logo.tsx`。再 `grep -rn "components/brand-logo" apps/web-agent/src` 应空。

- [ ] **Step 4:web-main root 加 themeScript**

在 `apps/web-main/src/app/layout.tsx`:import `import { themeScript } from "@meshbot/web-common";`;`<html lang="zh-CN" className={hanken.variable}>` 改为 `<html lang="zh-CN" suppressHydrationWarning className={hanken.variable}>`;在 `<body>` 前的 `<head>`(若无则新建)注入 themeScript:

```tsx
    <html lang="zh-CN" suppressHydrationWarning className={hanken.variable}>
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: themeScript
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
      </head>
      <body>
```

- [ ] **Step 5:web-main globals 加 @source 扫 web-common/shell**

在 `apps/web-main/src/app/globals.css` 已有的 `@source ".../web-common/src/im"` 之后加:

```css
@source "../../../../packages/web-common/src/shell";
```

- [ ] **Step 6:typecheck(两 app + web-common)**

Run:`pnpm --filter @meshbot/web-common typecheck && pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-main typecheck`
Expected:全 PASS。

- [ ] **Step 7:提交**

```bash
git add -A
git commit -m "feat(web-main): 壳基础——logo/themeScript/@source + BrandLogo 提升共享

logo.svg 补入 web-main public;root 加 themeScript+suppressHydration;globals 加 @source 扫
web-common/shell;BrandLogo 从 web-agent 提升进 @meshbot/web-common/shell,两端共用。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2:web-main areaFromPath + WorkspaceRail(深 rail 六项)

**Files:**
- Create: `apps/web-main/src/lib/area-from-path.ts`
- Create: `apps/web-main/src/components/shell/workspace-rail.tsx`

- [ ] **Step 1:web-main areaFromPath** — 新建 `apps/web-main/src/lib/area-from-path.ts`(六区,映射 web-main 路由):

```ts
/** web-main 壳 rail 区域(六项 + other)。 */
export type ShellArea =
  | "assistant"
  | "messages"
  | "skills"
  | "drive"
  | "flows"
  | "settings"
  | "other";

/** 由 pathname 推断当前 rail 区域。 */
export function areaFromPath(pathname: string): ShellArea {
  if (pathname.startsWith("/assistant")) return "assistant";
  if (pathname.startsWith("/messages")) return "messages";
  if (pathname.startsWith("/skills")) return "skills";
  if (pathname.startsWith("/drive")) return "drive";
  if (pathname.startsWith("/flows")) return "flows";
  if (pathname.startsWith("/settings")) return "settings";
  return "other";
}
```

- [ ] **Step 2:web-main WorkspaceRail** — 新建 `apps/web-main/src/components/shell/workspace-rail.tsx`(深 rail:BrandLogo + 六项 RailNavItem + 主题 + UserMenu 底):

```tsx
"use client";

import { BrandLogo, RailNavItem } from "@meshbot/web-common/shell";
import { useTheme } from "@meshbot/web-common/react";
import {
  Blocks,
  Bot,
  Folder,
  MessageSquare,
  Moon,
  Settings,
  Sun,
  Workflow,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { areaFromPath } from "@/lib/area-from-path";
import { UserMenu } from "@/components/common/user-menu";

/** web-main 深色 rail:六项(消息/设置 真跳,余占位)+ 主题 + 用户菜单。 */
export function WorkspaceRail() {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("appShell");
  const tCommon = useTranslations("common");
  const { theme, toggleTheme } = useTheme();
  const area = areaFromPath(pathname);

  return (
    <div className="flex h-full w-[68px] shrink-0 flex-col items-center gap-2 bg-(--shell-chrome) px-1.5 pt-2 pb-4">
      <BrandLogo size="sm" />
      <nav className="mt-1 flex w-full flex-col gap-1">
        <RailNavItem icon={<Bot className="h-5 w-5" />} label={t("rail.assistant")} active={area === "assistant"} onClick={() => router.push("/assistant")} />
        <RailNavItem icon={<MessageSquare className="h-5 w-5" />} label={t("rail.messages")} active={area === "messages"} onClick={() => router.push("/messages")} />
        <RailNavItem icon={<Blocks className="h-5 w-5" />} label={t("rail.skills")} active={area === "skills"} onClick={() => router.push("/skills")} />
        <RailNavItem icon={<Folder className="h-5 w-5" />} label={t("rail.drive")} active={area === "drive"} onClick={() => router.push("/drive")} />
        <RailNavItem icon={<Workflow className="h-5 w-5" />} label={t("rail.flows")} active={area === "flows"} onClick={() => router.push("/flows")} />
        <RailNavItem icon={<Settings className="h-5 w-5" />} label={t("rail.settings")} active={area === "settings"} onClick={() => router.push("/settings/org")} />
      </nav>
      <div className="flex-1" />
      <button
        type="button"
        onClick={toggleTheme}
        className="flex h-9 w-9 items-center justify-center rounded-(--shell-radius) text-white/65 transition-colors hover:bg-white/10 hover:text-white"
        title={theme === "dark" ? tCommon("switchToLightTheme") : tCommon("switchToDarkTheme")}
      >
        {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
      <UserMenu />
    </div>
  );
}
```

> i18n:`appShell.rail.*`(assistant/messages/skills/drive/flows/settings)与 `common.switchTo*Theme` —— web-main 的 `messages/{zh,en}.json` 现有这些 key?Step 3 会补。`UserMenu` 现是顶栏用的 Button 触发,放 rail 底可能样式偏大;本期先原样放,视觉冒烟看是否要收窄(P4b 精修)。

- [ ] **Step 3:补 i18n key** — `grep` web-main messages 是否有 `appShell.rail.assistant` 等;缺则在 `apps/web-main/messages/{zh,en}.json` 补 `appShell.rail`(assistant/messages/skills/drive/flows/settings)+ `common.switchToLightTheme`/`switchToDarkTheme`(值参考 web-agent 的 messages)。保持两语言对齐(`missing=0`)。

- [ ] **Step 4:typecheck** — `pnpm --filter @meshbot/web-main typecheck`。Expected PASS(此时 rail 引用的 `/assistant` 等路由 Task 3 才建,但 `router.push` 运行时跳转,typecheck 不因此失败)。

- [ ] **Step 5:提交**

```bash
git add apps/web-main/src/lib/area-from-path.ts apps/web-main/src/components/shell/workspace-rail.tsx apps/web-main/messages
git commit -m "feat(web-main): 深色 rail 六项 + areaFromPath

BrandLogo + 六项 RailNavItem(消息/设置真跳,助手/技能/网盘/流程占位)+ 主题 + UserMenu;
补 appShell.rail / common.switchTheme i18n。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3:web-main (shell) 布局 + 迁移真区 + 4 占位 + 首页

**Files:**
- Create: `apps/web-main/src/app/(shell)/layout.tsx`
- Move: `app/messages/*` → `app/(shell)/messages/*`;`app/settings/*` → `app/(shell)/settings/*`
- Modify: 迁移后的 `messages/layout.tsx`、`settings/layout.tsx`(去顶栏,rail 已承担导航)
- Create: `app/(shell)/assistant/page.tsx`、`skills/page.tsx`、`drive/page.tsx`、`flows/page.tsx`(占位)
- Modify: `apps/web-main/src/app/page.tsx`(首页重定向 → `/messages`)

- [ ] **Step 1:建 (shell) 持久壳** — 新建 `apps/web-main/src/app/(shell)/layout.tsx`:

```tsx
import type { ReactNode } from "react";
import { WorkspaceRail } from "@/components/shell/workspace-rail";

/** (shell) 段持久壳:深 rail + 内容区。切区不 remount rail。鉴权由根 Providers 的 AuthGuard 负责。 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-(--shell-chrome) text-foreground">
      <WorkspaceRail />
      <div className="min-h-0 flex-1 overflow-hidden pr-1.5 pb-1.5 pt-1.5">
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 2:迁移 messages/settings 进 (shell)**

```bash
git mv apps/web-main/src/app/messages apps/web-main/src/app/\(shell\)/messages
git mv apps/web-main/src/app/settings apps/web-main/src/app/\(shell\)/settings
```
(route group `(shell)` 不改 URL——`/messages`、`/settings/*` 保持。)

- [ ] **Step 3:迁移后 layout 去顶栏**

`app/(shell)/messages/layout.tsx`:去掉 `<header>`(标题 + 设置链接 + UserMenu)——导航现由 rail 承担。改为只渲染 `ImSidebar` + 内容(套一个白底内容卡 `bg-(--shell-content) rounded-(--shell-radius)`,与 web-agent PageShell 观感一致)。示意:

```tsx
"use client";
import type { ReactNode } from "react";
import { ImSidebar } from "@/components/im/im-sidebar";

export default function MessagesLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0">
      <ImSidebar />
      <main className="min-w-0 flex-1 overflow-auto rounded-(--shell-radius) bg-(--shell-content)">
        {children}
      </main>
    </div>
  );
}
```

`app/(shell)/settings/layout.tsx`:同理去 `<header>`,保留 `SettingsNav`(左导航)+ 内容卡。移除 `UserMenu`/`messagesLink` 顶栏(rail 已有)。`SettingsNav` 保留。

- [ ] **Step 4:建 4 个占位区页** — 每个新建 `app/(shell)/<area>/page.tsx`(assistant/skills/drive/flows),内容为居中"即将上线"空态。示例 `flows/page.tsx`:

```tsx
"use client";
import { Workflow } from "lucide-react";
import { useTranslations } from "next-intl";

export default function FlowsPage() {
  const t = useTranslations("shellStub");
  return (
    <div className="flex h-full items-center justify-center rounded-(--shell-radius) bg-(--shell-content)">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--shell-accent)/12 text-(--shell-accent)">
          <Workflow className="h-7 w-7" />
        </span>
        <div className="text-[15px] font-semibold text-foreground">{t("flows")}</div>
        <div className="max-w-[320px] text-[13px] text-muted-foreground">{t("comingHint")}</div>
      </div>
    </div>
  );
}
```
其余三页同结构,图标换 `Bot`(assistant)/`Blocks`(skills)/`Folder`(drive),标题 key 换 `assistant`/`skills`/`drive`。补 i18n `shellStub`(assistant/skills/drive/flows/comingHint)两语言。

- [ ] **Step 5:首页重定向 → /messages** — `apps/web-main/src/app/page.tsx`:把 `router.replace(authenticated ? "/settings/org" : "/login")` 改为 `router.replace(authenticated ? "/messages" : "/login")`。

- [ ] **Step 6:typecheck + build**

Run:`pnpm --filter @meshbot/web-main typecheck && pnpm --filter @meshbot/web-main build`(timeout 600000)。Expected:PASS(六路由齐)。

- [ ] **Step 7:视觉冒烟(人工,web-main 已部署——必做)** — `pnpm dev:web-main`(3002),登录后:
  - 深 rail 六项(助手/消息/技能/网盘/流程/设置),当前区高亮焦橙;BrandLogo 在顶、UserMenu 在底、主题按钮可切亮/暗。
  - 消息:进 IM(ImSidebar + 会话气泡,P3b 共享列表)正常;设置:左导航(组织/设备/模型)+ 内容正常。
  - 助手/技能/网盘/流程:点进各显"即将上线"空态。
  - 切组织 / 登出(UserMenu)正常;暗色下 rail/内容协调。
  - 旧顶栏文字链接已消失(导航靠 rail)。

- [ ] **Step 8:提交**

```bash
git add -A
git commit -m "feat(web-main): (shell) 统一壳——rail 内容区 + 迁移消息/设置 + 4 占位区

(shell)/layout 深 rail+内容区;messages/settings 迁进 (shell) 去顶栏(导航归 rail);
助手/技能/网盘/流程 占位空态;首页重定向 /messages。web-main 与 web-agent 壳统一。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾
- [ ] **Step 1:全量围栏** — `pnpm typecheck && pnpm check`;Expected 全绿(i18n missing=0)。
- [ ] **Step 2:两端一致性冒烟** — web-agent(3001)与 web-main(3002)登录后 rail 观感一致(深 rail 六项 + 焦橙高亮 + BrandLogo)。

---

## Self-Review
**1. 覆盖**:web-main 深 rail 六项(真区+占位)✅;BrandLogo 共享 ✅;themeScript/暗色 ✅;(shell) 壳 + 迁移真区去顶栏 ✅;4 占位 ✅;首页重定向 ✅。侧栏内部暖米化 + PageShellView 采用留 P4b(Global Constraints 说明)。
**2. 占位符**:rail/layout/占位页/area-from-path 全码;迁移用 `git mv`(URL 不变);i18n 缺 key 让实现者 grep 后补(不臆造现有 key)。
**3. 一致**:`ShellArea` 六值 + `RailNavItem`/`BrandLogo` 来自 `@meshbot/web-common/shell` 与 web-agent 同源;rail 结构复刻 web-agent(深 chrome + RailNavItem + 主题 + 头像)。
**4. 风险**:web-main 已部署,整条导航 UX 变——收尾强制冒烟;@source 漏加=class 静默丢(Task1-S5 + 冒烟);BrandLogo 共享用 next/image(各 app transpile 解析,logo.svg 各 app public 都补齐);UserMenu 放 rail 底样式可能偏大(冒烟看,P4b 精修)。

## 关于 P4b/P5(后续)
P4b:web-main 侧栏(ImSidebar/SettingsNav)重排暖米浅 + 采用共享 PageShellView + UserMenu 精修 rail 底样式。P5:登录前重构(web-agent 纯设备授权、web-main 邮箱验证码轻登录)。各自成 plan。
