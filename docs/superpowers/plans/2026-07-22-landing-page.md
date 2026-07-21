# MeshBot 官网落地页 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/web-main` 的 `/` 路由从「登录态重定向闸门」改造成公开可访问的官网落地页，9 段 + Footer，双主题、双语、带动效与降级。

**Architecture:** 页面主体为 Server Component 静态渲染，仅导航栏右侧 CTA 因 token 存于 localStorage 而必须是 client component。视觉严格照搬已批准的 mockup，样式落在 landing 专属的 scoped CSS 文件，**不写入 `packages/design`**。主题切换**复用仓库已有的 `useTheme` 机制**，不新建。

**Tech Stack:** Next.js 16 App Router · React 19 · Tailwind v4（布局）+ scoped CSS（图形语言）· next-intl · Jest（纯函数单测）

## Global Constraints

- 视觉唯一真相：`docs/superpowers/specs/assets/2026-07-22-landing-page-mockup.html`（520 行，已批准）。像素与文案以它为准。
- 设计依据：`docs/superpowers/specs/2026-07-22-landing-page-design.md`。**§2 内容真实性约束的 8 条禁止项为硬性**，任何文案不得触犯。
- **主题机制是 `<html>` 上的 `.dark` class，不是 `data-theme`。** mockup 里用的 `data-theme` 是脱离仓库体系的写法，移植时必须改。深色样式一律写作 `.dark .lp-xxx { … }`，与 `packages/design/src/styles/globals.css:1` 的 `@custom-variant dark (&:is(.dark *))` 对齐。
- 主题切换**必须复用** `useTheme()`（`@meshbot/web-common/react`），返回 `{ theme, setTheme, toggleTheme }`，`Theme = "light" | "dark" | "system"`。防闪烁的 `themeScript` 已在 `apps/web-main/src/app/layout.tsx:28` 挂载，**不要重复挂**。
- 所有用户可见字符串走 next-intl，新增 `landing` namespace，zh 与 en **均按正式文案撰写**（`i18n-page` 技能）。
- 动画只动 `transform` / `opacity`。**不引入 framer-motion**。
- `prefers-reduced-motion: reduce` 下所有动画停用且信息零丢失。
- **web-main 的 jest spec 必须用相对导入**（`from "./x"`）。`jest.config.ts` 的 `moduleNameMapper` 把 `^@/(.*)$` 映射到 `apps/web-agent/src`，在 web-main 的 spec 里用 `@/` 会解析到错误的包。
- 品牌名用户可见处写作 **MeshBot**（大驼峰）。
- 提交信息用中文，遵循 conventional commits。

---

### Task 1: 下载平台探测（纯函数 + 单测）

唯一有真实单测价值的逻辑单元，先做。

**Files:**
- Create: `apps/web-main/src/lib/download-platform.ts`
- Test: `apps/web-main/src/lib/download-platform.spec.ts`

**Interfaces:**
- Produces: `detectPlatform(ua: string): Platform`，`type Platform = "mac" | "win" | "linux" | "unknown"`；`RELEASES_LATEST_URL: string`

- [ ] **Step 1: 写失败的测试**

创建 `apps/web-main/src/lib/download-platform.spec.ts`：

```ts
import { detectPlatform } from "./download-platform";

describe("detectPlatform", () => {
  it("识别 macOS", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      ),
    ).toBe("mac");
  });

  it("识别 Windows", () => {
    expect(
      detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"),
    ).toBe("win");
  });

  it("识别 Linux（且不被 Android 误判）", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });

  it("Android 不算 linux 桌面端", () => {
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("unknown");
  });

  it("iPhone 归为 unknown（无桌面端产物）", () => {
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(
      "unknown",
    );
  });

  it("空串归为 unknown", () => {
    expect(detectPlatform("")).toBe("unknown");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest apps/web-main/src/lib/download-platform.spec.ts`
Expected: FAIL — `Cannot find module './download-platform'`

- [ ] **Step 3: 最小实现**

创建 `apps/web-main/src/lib/download-platform.ts`：

```ts
/** 桌面端产物覆盖的平台；移动端与未知一律 unknown。 */
export type Platform = "mac" | "win" | "linux" | "unknown";

/** GitHub Releases 最新版页面；无 Release 时此链接仍可访问（显示空列表）。 */
export const RELEASES_LATEST_URL = "https://github.com/meta1top/Meshbot/releases/latest";

/**
 * 从 User-Agent 推断桌面平台。
 * iPhone 的 UA 含 "Mac OS X"、Android 的 UA 含 "Linux"，故移动端必须先排除。
 */
export function detectPlatform(ua: string): Platform {
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return "unknown";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "win";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "unknown";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm jest apps/web-main/src/lib/download-platform.spec.ts`
Expected: PASS，6 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add apps/web-main/src/lib/download-platform.ts apps/web-main/src/lib/download-platform.spec.ts
git commit -m "feat(web-main): 落地页下载 CTA 的平台探测纯函数"
```

---

### Task 2: 页面骨架 + 样式基座 + 导航栏（第一个可验证交付点）

做完这一步应当能在浏览器里打开 `/` 看到导航栏、主题可切换、双语可切换。**建议在此暂停给用户实机看一眼**再继续后面的段落。

**Files:**
- Create: `apps/web-main/src/components/landing/landing.css`
- Create: `apps/web-main/src/components/landing/landing-nav.tsx`
- Modify: `apps/web-main/src/app/page.tsx`（整体重写）
- Modify: `apps/web-main/messages/zh.json`、`apps/web-main/messages/en.json`

**Interfaces:**
- Consumes: `detectPlatform`、`RELEASES_LATEST_URL`（Task 1）
- Produces: `.lp-root` 样式作用域与全套 CSS 变量；`<LandingNav />`；`landing.*` i18n keys

- [ ] **Step 1: 建立样式基座**

创建 `apps/web-main/src/components/landing/landing.css`。从 mockup 第 8–36 行搬 CSS 变量，**但把 `:root[data-theme="light"]` / `[data-theme="dark"]` 的双分支改写为「默认浅色 + `.dark` 覆盖」**：

```css
/* 落地页专属样式作用域。仅本页使用，不得提升到 packages/design。 */
.lp-root {
  --lp-bg: #f2ece3;
  --lp-panel: #faf7f2;
  --lp-card: #ffffff;
  --lp-line: #e6ded4;
  --lp-edge: #d5c9b9;
  --lp-fg: #241c15;
  --lp-dim: #6b5d4f;
  --lp-faint: #9a8b7b;
  --lp-grid: rgba(210, 74, 13, 0.11);
  --lp-glow: rgba(210, 74, 13, 0.1);
  --lp-mesh: rgba(210, 74, 13, 0.32);
  --lp-brand: #c04409;
  --lp-brand-lt: #a83b07;
  --lp-ok: #2f7d3a;
  --lp-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  background: var(--lp-bg);
  color: var(--lp-fg);
}

.dark .lp-root {
  --lp-bg: oklch(0.135 0.008 55);
  --lp-panel: oklch(0.175 0.009 55);
  --lp-card: oklch(0.205 0.011 55);
  --lp-line: oklch(0.245 0.009 55);
  --lp-edge: oklch(0.29 0.011 55);
  --lp-fg: oklch(0.96 0.005 55);
  --lp-dim: oklch(0.7 0.012 55);
  --lp-faint: oklch(0.55 0.011 55);
  --lp-grid: rgba(232, 130, 63, 0.1);
  --lp-glow: rgba(210, 74, 13, 0.13);
  --lp-mesh: rgba(210, 74, 13, 0.34);
  --lp-brand: #d24a0d;
  --lp-brand-lt: #e8823f;
  --lp-ok: #3fa34d;
}
```

再把 mockup 第 38–46 行的三种图形语言原样搬入，类名加 `lp-` 前缀：

```css
.lp-dots {
  background-image: radial-gradient(circle, var(--lp-grid) 1px, transparent 1px);
  background-size: 23px 23px;
}
.lp-scan {
  background-image: repeating-linear-gradient(180deg, var(--lp-grid) 0 1px, transparent 1px 7px);
}
.lp-glow-tl::after,
.lp-glow-br::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 1;
}
.lp-glow-tl::after {
  background: radial-gradient(640px 300px at 12% 0%, var(--lp-glow), transparent 68%);
}
.lp-glow-br::after {
  background: radial-gradient(560px 280px at 88% 100%, var(--lp-glow), transparent 68%);
}
```

最后加统一的降级块（后续任务的动画都要被它覆盖）：

```css
@media (prefers-reduced-motion: reduce) {
  .lp-root *,
  .lp-root *::before,
  .lp-root *::after {
    animation: none !important;
    transition: none !important;
  }
  .lp-root .lp-fade {
    opacity: 1 !important;
    transform: none !important;
  }
}
```

- [ ] **Step 2: 加 i18n 文案**

在 `apps/web-main/messages/zh.json` 顶层加 `landing` namespace：

```json
"landing": {
  "nav": { "features": "能力", "docs": "文档", "github": "GitHub", "login": "登录", "enterApp": "进入应用", "start": "免费开始", "toggleTheme": "切换深色/浅色主题" },
  "hero": {
    "eyebrow": "TEAM · AGENTS",
    "titleTop": "同一个",
    "titleAccent": "工作空间",
    "lead": "你的团队在这里协作，你的 Agent 带着各自的人格、技能和记忆一起工作。会话与记忆留在本机。",
    "download": "下载桌面端",
    "platforms": "macOS · Windows · Linux"
  }
}
```

`apps/web-main/messages/en.json` 同结构，正式英文：

```json
"landing": {
  "nav": { "features": "Features", "docs": "Docs", "github": "GitHub", "login": "Sign in", "enterApp": "Open app", "start": "Get started", "toggleTheme": "Toggle dark/light theme" },
  "hero": {
    "eyebrow": "TEAM · AGENTS",
    "titleTop": "One shared",
    "titleAccent": "workspace",
    "lead": "Your team collaborates here. Your agents work alongside them, each with its own persona, skills and memory. Conversations and memory stay on your machine.",
    "download": "Download desktop",
    "platforms": "macOS · Windows · Linux"
  }
}
```

- [ ] **Step 3: 写导航栏组件**

创建 `apps/web-main/src/components/landing/landing-nav.tsx`。**这是全页唯一的 client component**：

```tsx
"use client";

import { useTheme } from "@meshbot/web-common/react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useProfile } from "@/rest/auth";

/**
 * 落地页导航栏。因 token 存于 localStorage、服务端无法获知登录态，
 * 右侧入口初始渲染固定宽度骨架，profile 到达后再定；避免向已登录用户
 * 显示「登录」这一错误信息，也避免布局跳动。
 */
export function LandingNav() {
  const t = useTranslations("landing.nav");
  const { toggleTheme } = useTheme();
  const profile = useProfile();
  const authenticated = profile.isSuccess && profile.data.user != null;

  return (
    <nav className="lp-nav">
      <div className="lp-nav-in">
        <div className="lp-mark">
          <i />
          MeshBot
        </div>
        <div className="lp-nav-l">
          <a href="#features">{t("features")}</a>
          <a href="/docs">{t("docs")}</a>
          <a href="https://github.com/meta1top/Meshbot">{t("github")}</a>
        </div>
        <div className="lp-nav-r">
          <button
            type="button"
            className="lp-tgl"
            onClick={toggleTheme}
            aria-label={t("toggleTheme")}
          >
            ◐
          </button>
          {profile.isPending ? (
            <span className="lp-skel" aria-hidden />
          ) : (
            <Link className="lp-btn lp-btn-t" href={authenticated ? "/assistant" : "/login"}>
              {authenticated ? t("enterApp") : t("login")}
            </Link>
          )}
          <Link className="lp-btn lp-btn-p" href="/register">
            {t("start")}
          </Link>
        </div>
      </div>
    </nav>
  );
}
```

对应样式补进 `landing.css`（从 mockup 第 63–75 行移植，类名加前缀）。`.lp-skel` 是新增的骨架：

```css
.lp-skel {
  display: inline-block;
  width: 52px;
  height: 30px;
  border: 1px solid var(--lp-edge);
  border-radius: 2px;
  opacity: 0.45;
}
```

- [ ] **Step 4: 重写页面入口**

整体替换 `apps/web-main/src/app/page.tsx`：

```tsx
import { LandingNav } from "@/components/landing/landing-nav";
import "@/components/landing/landing.css";

/** 官网落地页。公开可访问，已登录用户同样看到本页（经导航栏入口进应用）。 */
export default function Home() {
  return (
    <div className="lp-root">
      <LandingNav />
    </div>
  );
}
```

原先的登录态重定向逻辑整体删除。

- [ ] **Step 5: 补 i18n stub 并验证**

```bash
pnpm sync:locales --write
pnpm sync:locales -- --check
pnpm typecheck
```
Expected: `--check` 输出 `Done (missing=0, asymmetric=0)`；typecheck 无错误

- [ ] **Step 6: 实机验证**

```bash
pnpm dev:web-main
```
打开 `http://localhost:3102/`。确认：导航栏渲染；点 ◐ 深浅主题切换生效且无闪烁；未登录时右侧显示「登录」。

- [ ] **Step 7: 提交**

```bash
git add apps/web-main/src/app/page.tsx apps/web-main/src/components/landing/ apps/web-main/messages/
git commit -m "feat(web-main): 落地页骨架与导航栏，/ 路由改为公开页"
```

---

### Task 3: HERO 区

**Files:**
- Create: `apps/web-main/src/components/landing/landing-hero.tsx`
- Modify: `apps/web-main/src/components/landing/landing.css`、`apps/web-main/src/app/page.tsx`、`apps/web-main/messages/{zh,en}.json`

**Interfaces:**
- Consumes: `.lp-root` 变量、`.lp-dots`、`.lp-glow-tl`（Task 2）；`detectPlatform`、`RELEASES_LATEST_URL`（Task 1）
- Produces: `<LandingHero />`

- [ ] **Step 1: 移植 HERO 结构**

创建 `landing-hero.tsx`，照 mockup 第 239–271 行移植。这是 Server Component（无 `"use client"`），所有文案改为 `t()`。三栏工作空间全景的入场动画用 CSS `animation-delay`，延迟值与 mockup 一致：`.25s / 1.5s / 4.6s`（左栏消息）、`2.1s / 2.8s / 3.5s / 4.1s`（中栏工具行与产物）。

下载按钮直接指向 `RELEASES_LATEST_URL`（Task 1 的常量）。平台探测用于按钮副文案，放在 Task 8 统一接入 client 侧；本步先渲染静态的 `t("hero.platforms")`。

- [ ] **Step 2: 补 hero 样式**

从 mockup 第 77–94 行移植 `.hero` / `.ws` / `.ws-col` / `.msg` / `.trow` / `.art` / `.agent-row` / `.fade` / `.breathe`，全部加 `lp-` 前缀。

- [ ] **Step 3: 挂进页面**

`page.tsx` 里 `<LandingNav />` 之后加 `<LandingHero />`。

- [ ] **Step 4: 验证**

```bash
pnpm sync:locales -- --check && pnpm typecheck
```
浏览器打开 `/`，确认三栏全景在两种主题下都正确、入场动画按序播放。系统开启「减少动态效果」后刷新，确认内容直接静态呈现、无位移。

- [ ] **Step 5: 提交**

```bash
git add apps/web-main/src/components/landing/ apps/web-main/src/app/page.tsx apps/web-main/messages/
git commit -m "feat(web-main): 落地页 HERO 区与工作空间全景动效"
```

---

### Task 4: 02 Agent 构成 + 03 对话演示

两段都是「讲 Agent 本身」，会被一起 review，合为一个 task。

**Files:**
- Create: `apps/web-main/src/components/landing/landing-agent-anatomy.tsx`、`apps/web-main/src/components/landing/landing-conversation.tsx`
- Modify: `landing.css`、`page.tsx`、`messages/{zh,en}.json`

**Interfaces:**
- Produces: `<LandingAgentAnatomy />`、`<LandingConversation />`

- [ ] **Step 1: 02 放射 mesh 图**

照 mockup 第 273–298 行移植。SVG 的五条 `path` 与 `.dash` 流动动画（`stroke-dasharray: 4 5` + `@keyframes march`）原样保留，`animation-delay` 分别为 `0 / -2s / -4s / -6s / -3s`。五个卫星节点用绝对定位百分比，值照抄 mockup。

样式取 mockup 第 95–107 行。

- [ ] **Step 2: 03 对话演示**

照 mockup 第 300–345 行移植。含任务清单卡、执行步骤、提问卡（四选项，其中「其他…」为弱色）、产物卡、发送确认卡。

样式取 mockup 第 108–136 行。

**文案红线**：产物卡里两条阻塞项是真实内容，保留原文，不要替换成泛化示例。

- [ ] **Step 3: 挂进页面并验证**

```bash
pnpm sync:locales -- --check && pnpm typecheck
```
浏览器确认放射图连线在两主题下可见、对话卡片层次正确。

- [ ] **Step 4: 提交**

```bash
git add apps/web-main/src/components/landing/ apps/web-main/src/app/page.tsx apps/web-main/messages/
git commit -m "feat(web-main): 落地页 Agent 构成放射图与对话演示"
```

---

### Task 5: 04 团队协作 + 05 MCP 迁移

**Files:**
- Create: `apps/web-main/src/components/landing/landing-team.tsx`、`apps/web-main/src/components/landing/landing-mcp.tsx`
- Modify: `landing.css`、`page.tsx`、`messages/{zh,en}.json`

**Interfaces:**
- Produces: `<LandingTeam />`、`<LandingMcp />`

- [ ] **Step 1: 04 三栏 IM 界面**

照 mockup 第 347–377 行移植（频道列表含未读徽标、消息流、成员在线态）。样式取第 137–149 行。

**文案红线**：此段禁止出现「Agent 是频道成员」「群组」。准确表述为「Agent 读得到频道内容，也能替你起草回复」。

- [ ] **Step 2: 05 MCP 代码块**

照 mockup 第 379–405 行移植。`.lp-code::before` 的橙光横扫动画（`@keyframes sweep`，4.2s）保留。代码块内容是 JSON 示例，**不进 i18n**（代码不翻译），只有左侧说明文字走 `t()`。

样式取 mockup 第 150–160 行。

- [ ] **Step 3: 挂进页面并验证**

```bash
pnpm sync:locales -- --check && pnpm typecheck
```

- [ ] **Step 4: 提交**

```bash
git add apps/web-main/src/components/landing/ apps/web-main/src/app/page.tsx apps/web-main/messages/
git commit -m "feat(web-main): 落地页团队协作与 MCP 迁移区块"
```

---

### Task 6: 06 远程续跑 + 07 数据边界

**Files:**
- Create: `apps/web-main/src/components/landing/landing-remote.tsx`、`apps/web-main/src/components/landing/landing-data-zones.tsx`
- Modify: `landing.css`、`page.tsx`、`messages/{zh,en}.json`

**Interfaces:**
- Produces: `<LandingRemote />`、`<LandingDataZones />`

- [ ] **Step 1: 06 远程 + 波纹**

照 mockup 第 407–435 行移植。链路脉冲 `@keyframes flow`（3.4s）与同心波纹 `@keyframes rip`（3.4s，第二个 `animation-delay: 1.1s`）保留。样式取第 161–174 行。

**文案红线**：说「在手机上」，不要说「手机浏览器」——手机 App 已在规划中，措辞不锁死。

- [ ] **Step 2: 07 数据三档**

照 mockup 第 437–459 行移植。三档的底纹密度递减（`.lp-zone-1` 实心卡 / `.lp-zone-2` 斜向条纹 / `.lp-zone-3` 稀疏点阵）必须保留，这是该段的图形语言。样式取第 175–187 行。

**文案红线（最重要的一条）**：中间那档「过境，但不留存」**不得删除或弱化**。三档缺一，「数据不出本地」就成了可被证伪的虚假主张。三档内容严格照 spec §2 的表格。

- [ ] **Step 3: 挂进页面并验证**

```bash
pnpm sync:locales -- --check && pnpm typecheck
```
逐字比对 07 段三档文案与 spec §2 表格。

- [ ] **Step 4: 提交**

```bash
git add apps/web-main/src/components/landing/ apps/web-main/src/app/page.tsx apps/web-main/messages/
git commit -m "feat(web-main): 落地页远程续跑与数据边界三档"
```

---

### Task 7: 08 分享 + 09 上手 + Footer

**Files:**
- Create: `apps/web-main/src/components/landing/landing-share.tsx`、`apps/web-main/src/components/landing/landing-onboarding.tsx`、`apps/web-main/src/components/landing/landing-footer.tsx`
- Modify: `landing.css`、`page.tsx`、`messages/{zh,en}.json`

**Interfaces:**
- Produces: `<LandingShare />`、`<LandingOnboarding />`、`<LandingFooter />`

- [ ] **Step 1: 08 分享卡**

照 mockup 第 461–477 行移植。三个开关状态：需要密码 ✓ / 7 天后过期 ✓ / 允许下载原文件 ✗。样式取第 188–198 行。

- [ ] **Step 2: 09 上手四步 + 收尾 CTA**

照 mockup 第 479–493 行移植。等宽大号数字 `01–04`。收尾双 CTA 与 hero 一致（免费开始 → `/register`，下载桌面端 → `RELEASES_LATEST_URL`）。样式取第 199–210 行。

- [ ] **Step 3: Footer**

照 mockup 第 495–506 行移植，四栏导航。样式取第 212–217 行。

**注意**：「许可证」链接当前无目标（仓库尚无 LICENSE，见 spec §7）。本任务先指向 `https://github.com/meta1top/Meshbot`，等 LICENSE 补齐后改为具体文件链接——不要留 `href="#"`。

- [ ] **Step 4: 挂进页面并验证**

```bash
pnpm sync:locales -- --check && pnpm typecheck && pnpm build --filter web-main
```

- [ ] **Step 5: 提交**

```bash
git add apps/web-main/src/components/landing/ apps/web-main/src/app/page.tsx apps/web-main/messages/
git commit -m "feat(web-main): 落地页分享卡、上手四步与页脚"
```

---

### Task 8: 动画视口门控 + 平台探测接入 + 全量验收

**Files:**
- Create: `apps/web-main/src/components/landing/use-in-view.ts`
- Create: `apps/web-main/src/components/landing/landing-download-button.tsx`
- Modify: `landing.css`、各 section 组件（加 `data-lp-anim` 标记）

**Interfaces:**
- Consumes: `detectPlatform`、`RELEASES_LATEST_URL`（Task 1）
- Produces: `useInView(ref): boolean`、`<LandingDownloadButton />`

- [ ] **Step 1: 视口门控 hook**

创建 `use-in-view.ts`：

```ts
"use client";

import { type RefObject, useEffect, useState } from "react";

/** 元素进入视口后返回 true 并停止观察；用于让落地页动画只在可见时播放。 */
export function useInView(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  return inView;
}
```

在 `landing.css` 里让动画默认暂停、进入视口才播：

```css
.lp-root [data-lp-anim] {
  animation-play-state: paused;
}
.lp-root [data-lp-anim][data-in-view="true"] {
  animation-play-state: running;
}
```

给 02 / 05 / 06 三段的循环动画元素加 `data-lp-anim`（HERO 因在首屏，无需门控）。

- [ ] **Step 2: 下载按钮接入平台探测**

创建 `landing-download-button.tsx`（client component），用 `detectPlatform(navigator.userAgent)` 决定副文案；`unknown` 时回退到 `t("hero.platforms")` 的全平台列表。链接恒为 `RELEASES_LATEST_URL`。替换 hero 与第 09 段里的静态下载按钮。

- [ ] **Step 3: 无障碍与设计规范审查**

调用 `web-design-guidelines` 技能审查 `apps/web-main/src/components/landing/` 下全部文件，逐条修复它报出的问题（重点：图标按钮的 `aria-label`、焦点态、语义标签、对比度）。

- [ ] **Step 4: 多断点多主题截图**

用 Playwright MCP 在 375 / 768 / 1440 三个宽度、深浅两主题下各截一张，共 6 张，逐张确认无横向滚动、无重叠、无溢出。

- [ ] **Step 5: reduced-motion 与键盘验收**

系统开启「减少动态效果」后刷新，确认全页无任何动画且信息完整。用 Tab 走一遍，确认所有 CTA 与主题切换按钮可聚焦且焦点态清晰。

- [ ] **Step 6: 内容红线自查**

对照 spec §2 的 8 条禁止项，逐条在页面正文里搜索确认未出现：工作流 / flows、Agent 与 Agent 协作、群组、Agent 是频道成员、语义记忆、安全可控、Homebrew、网盘人类操作界面。

- [ ] **Step 7: 全量围栏**

```bash
pnpm lint && pnpm typecheck && pnpm check && pnpm sync:locales -- --check && pnpm build
```
Expected: 全部通过。**读完整输出，不要只看退出码。**

- [ ] **Step 8: 提交**

```bash
git add apps/web-main/src/components/landing/
git commit -m "feat(web-main): 落地页动画视口门控、平台探测下载与无障碍修复"
```

---

## 自查结果

**Spec 覆盖**：§1 定位 → Task 2/3 文案；§2 内容红线 → Task 4/5/6 分散约束 + Task 8 Step 6 统一自查；§3 九段结构 → Task 3–7 全覆盖；§4 视觉规范 → Task 2 Step 1 变量表 + 各段样式移植；§5 技术实现 → Task 2（Server Component / 删重定向 / 登录态骨架）、Task 8（动画门控、下载降级）；§6 验收 → Task 8 Step 3–7 逐条对应。

**已修正的不一致**：mockup 用 `data-theme` 与仓库 `.dark` class 机制冲突，已在 Global Constraints 与 Task 2 Step 1 明确改写规则；mockup 自带的 `<script>` 主题切换（第 508 行起）不移植，改用既有 `useTheme()`。

**已知缺口（有意为之）**：落地页组件无单元测试。web-main 虽有 jest（`apps/web-main/src/lib/*.spec.ts` 已存在），但静态展示组件的单测价值低于维护成本；真实验证走 Task 8 的截图、a11y 审查与构建围栏。有测试价值的纯逻辑（平台探测）已在 Task 1 用 TDD 覆盖。
