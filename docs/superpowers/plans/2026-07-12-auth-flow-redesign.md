# 登录/注册/设备授权全流程重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 五步注册授权向导 + 静默 loopback 收尾 + 全部 auth 页面视觉升级 + 加载规范（Skeleton 组件与 loading-states 技能）。

**Architecture:** 向导是「视觉连续」而非路由重构——register 页承载 ①账号②验证，authorize 页内嵌承载 ③组织④模型⑤确认（现有 OrgOnboarding 模式扩展），`WizardSteps` 步骤指示组件双页复用。loopback 同机安全模型不动。视觉底座在两端共享的 `PreLoginShellView` 做一次，两端受益。

**Tech Stack:** Next.js + next-intl + React Query + Form/FormItem/useSchema + Tailwind v4

## Global Constraints

- 分支 `feat/langchain-1x` 连续提交，不切 PR；中文 conventional commits。
- 前端新增文案全部走 next-intl，加 key 后 `pnpm sync:locales -- --write`。
- 表单一律 `Form/FormItem + useSchema`（web-form-convention 技能）。
- 品牌色不变：暖米底 `--surface-0` / 橙 `--shell-accent`；用户可见品牌名写 **MeshBot**。
- 每 Task 结束：`pnpm --filter <包> typecheck` + 相关测试 + 独立 commit。
- server-main 是编译产物：涉及 libs/main 的 Task 完成后需 `pnpm build:server-main` 才对本地云端生效（终验前统一做一次即可）。

---

### Task 1: 授权请求 TTL 10→30 分钟（云端 + 桌面端）

**Files:**
- Modify: `libs/main/src/services/device-auth.service.ts:9`
- Modify: `apps/web-agent/src/app/login/page.tsx:28`
- Test: `libs/main/src/services/device-auth.service.spec.ts`

**Interfaces:**
- Produces: 无对外接口变化，仅常量语义（注册链路留足时间）。

- [ ] **Step 1: 改 TTL 常量**

`libs/main/src/services/device-auth.service.ts`：

```ts
/** 授权请求有效期：30 分钟（注册→验码→建组织→配模型全链路留足时间）。 */
const REQUEST_TTL_MS = 30 * 60 * 1000;
```

`apps/web-agent/src/app/login/page.tsx`：

```ts
const WAIT_TIMEOUT_MS = 30 * 60 * 1000;
```

- [ ] **Step 2: spec 断言更新**

打开 `libs/main/src/services/device-auth.service.spec.ts`，搜其中对过期时间的现有用例（`expiresAt` 相关）。若有硬编码 10 分钟的断言改为 30 分钟；若无时间断言则新增一条：

```ts
it("create 的授权请求有效期为 30 分钟", async () => {
  // 按该 spec 现有 build/make 辅助创建 service 与请求
  const before = Date.now();
  const req = await svc.create({ deviceName: "d", platform: "darwin" });
  const ttl = rows[0].expiresAt.getTime() - before;
  expect(ttl).toBeGreaterThanOrEqual(29 * 60 * 1000);
  expect(ttl).toBeLessThanOrEqual(31 * 60 * 1000);
});
```

（变量名 `svc`/`rows` 以该 spec 文件现有夹具为准，保持同风格。）

- [ ] **Step 3: 跑测试**

Run: `npx jest libs/main/src/services/device-auth.service.spec.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(auth): 设备授权请求 TTL 延至 30 分钟——注册链路留足时间"
```

---

### Task 2: server-agent 回调页品牌化（替换裸文本）

**Files:**
- Create: `apps/server-agent/src/controllers/authorize-result.page.ts`
- Modify: `apps/server-agent/src/controllers/auth.controller.ts:44-49`
- Test: `apps/server-agent/src/controllers/authorize-result.page.spec.ts`

**Interfaces:**
- Produces: `renderAuthorizeResultPage(kind: "success" | "failure"): string` —— 完整 HTML 文档字符串，无外部资源。

- [ ] **Step 1: 写失败测试**

`authorize-result.page.spec.ts`：

```ts
import { renderAuthorizeResultPage } from "./authorize-result.page";

describe("renderAuthorizeResultPage", () => {
  it("成功页含品牌名/成功文案/自动关闭脚本", () => {
    const html = renderAuthorizeResultPage("success");
    expect(html).toContain("MeshBot");
    expect(html).toContain("授权成功");
    expect(html).toContain("window.close");
  });

  it("失败页含失败文案与重试引导，不含成功文案", () => {
    const html = renderAuthorizeResultPage("failure");
    expect(html).toContain("授权失败");
    expect(html).toContain("回到 MeshBot 桌面端重试");
    expect(html).not.toContain("授权成功");
  });

  it("无外部资源引用（自包含单文件）", () => {
    const html = renderAuthorizeResultPage("success");
    expect(html).not.toMatch(/src="http|href="http/);
  });
});
```

Run: `npx jest apps/server-agent/src/controllers/authorize-result.page.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 2: 实现页面模板**

`authorize-result.page.ts`（要点：暖米底 #f7f2ea、深炭 #2b2723 logo 方块、绿对勾圆环扩散动画 / 红叉、`window.close()` 延时尝试；全部内联样式）：

```ts
/**
 * loopback 回调结果页（成功/失败）——浏览器完成授权码回传后的落地页。
 * 自包含单文件 HTML（内联样式/脚本，无外部资源），品牌视觉与 web 端 auth 流程一致。
 */
export function renderAuthorizeResultPage(kind: "success" | "failure"): string {
  const ok = kind === "success";
  const icon = ok
    ? `<div class="ring ok"><span>✓</span></div>`
    : `<div class="ring bad"><span>✕</span></div>`;
  const title = ok ? "授权成功" : "授权失败或已过期";
  const sub = ok
    ? "MeshBot 桌面端已自动登录，本页可以关闭。"
    : "请回到 MeshBot 桌面端重试。";
  const closeScript = ok
    ? `<script>setTimeout(function(){window.close()},1500)</script>`
    : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MeshBot</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#f7f2ea;font-family:-apple-system,"PingFang SC",sans-serif;color:#2b2723}
  .wrap{text-align:center;padding:32px}
  .logo{display:inline-flex;align-items:center;gap:8px;margin-bottom:24px;font-weight:800}
  .logo i{display:inline-flex;width:34px;height:34px;background:#2b2723;border-radius:9px;
    color:#fff;align-items:center;justify-content:center;font-style:normal}
  .ring{width:56px;height:56px;margin:0 auto 14px;border-radius:50%;
    display:flex;align-items:center;justify-content:center;animation:pop .4s ease-out}
  .ring span{width:34px;height:34px;border-radius:50%;color:#fff;display:flex;
    align-items:center;justify-content:center;font-size:18px;font-weight:800}
  .ring.ok{background:rgba(22,163,74,.1)} .ring.ok span{background:#16a34a}
  .ring.bad{background:rgba(220,38,38,.08)} .ring.bad span{background:#dc2626}
  h1{font-size:18px;margin:0} p{font-size:13px;color:#8a8178;margin-top:8px}
  @keyframes pop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}
</style></head><body><div class="wrap">
  <div class="logo"><i>M</i>MeshBot</div>
  ${icon}<h1>${title}</h1><p>${sub}</p>
</div>${closeScript}</body></html>`;
}
```

`auth.controller.ts` 回调 handler 改为：

```ts
try {
  await this.deviceAuthorize.complete(requestId, code);
  return renderAuthorizeResultPage("success");
} catch {
  return renderAuthorizeResultPage("failure");
}
```

（顶部补 `import { renderAuthorizeResultPage } from "./authorize-result.page";`）

- [ ] **Step 3: 跑测试 + typecheck**

Run: `npx jest apps/server-agent/src/controllers/authorize-result.page.spec.ts && pnpm --filter @meshbot/server-agent typecheck`
Expected: PASS / 0 errors

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(server-agent): loopback 回调页品牌化——替换裸文本 HTML"
```

---

### Task 3: 批准收尾静默化（authorize 页状态机修正）

**Files:**
- Modify: `apps/web-main/src/app/authorize/page.tsx`
- Modify: `apps/web-main/messages/{zh,en}.json`（authorize 命名空间加 `finishing`、`fallback.*`）

**Interfaces:**
- Consumes: 现有 `useApproveDevice`、sessionStorage 恢复机制（key `authorize:code:<requestId>`）。
- Produces: 批准后新状态 `finishing`（spinner），授权码卡片仅 sessionStorage 恢复路径渲染。

- [ ] **Step 1: 状态机修正**

`authorize/page.tsx` 关键改动（原 `approveResult` 渲染 ApprovedCard 的分支删除）：

```tsx
// 批准成功且带 redirectUri：显示「正在完成授权…」并跳 loopback；
// 无 redirectUri（罕见：请求未带回调）才直接展示授权码兜底卡。
if (approveResult) {
  if (approveResult.redirectUri) {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
        <p className="text-sm text-muted-foreground">{t("finishing")}</p>
      </div>
    );
  }
  return <ApprovedCard userCode={approveResult.userCode} fallback />;
}
```

`ApprovedCard` 加 `fallback?: boolean`：fallback（含 sessionStorage 恢复路径）时卡片顶部渲染黄提示条：

```tsx
{fallback && (
  <Alert className="border-amber-300/60 bg-amber-50 text-amber-900">
    <AlertDescription>{t("fallback.hint")}</AlertDescription>
  </Alert>
)}
```

sessionStorage 恢复分支同样传 `fallback`：`<ApprovedCard userCode={storedCode} fallback />`。

同文件顺带完成 spec 的「已拒绝页弱化处理」：denied 分支卡片内容改为灰叉圆环 + 标题 + 「可关闭本页」：

```tsx
if (denied) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <span className="text-lg text-muted-foreground">✕</span>
      </div>
      <p className="text-sm font-semibold">{t("denied.title")}</p>
      <p className="text-xs text-muted-foreground">{t("denied.description")}</p>
    </div>
  );
}
```

- [ ] **Step 2: i18n**

zh：`"finishing": "正在完成授权…"`、`"fallback.hint": "自动完成失败——请复制下方授权码，回到桌面端「手动输入授权码」粘贴。"`；en 对应翻译。`pnpm sync:locales -- --write`。

- [ ] **Step 3: typecheck + 手验逻辑**

Run: `pnpm --filter @meshbot/web-main typecheck`
Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "fix(web-main): 批准收尾静默化——授权码只做 loopback 失败兜底"
```

---

### Task 4: 视觉底座（光晕壳 + 卡片语言 + 切换动效，两端共享）

**Files:**
- Modify: `packages/web-common/src/shell/pre-login-shell.tsx`（光晕背景层）
- Create: `packages/web-common/src/shell/auth-card.tsx`（统一卡片容器）
- Modify: `packages/web-common/src/shell/index.ts`（导出 AuthCard）
- Modify: `apps/web-main/src/components/auth/auth-shell.tsx`（子内容套 AuthCard 的接线在各页 Task 做，此处仅确认壳）

**Interfaces:**
- Produces: `AuthCard({ children, className })` —— 白底 rounded-2xl、双层阴影、内容切换淡入动效的卡片容器；`PreLoginShellView` 背景带光晕。

- [ ] **Step 1: PreLoginShellView 加光晕层**

根 div 内容前插入（纯装饰，`pointer-events-none`，暗色主题下透明度减半靠 CSS 变量不引入新变量、直接低透明度即可两端通用）：

```tsx
<div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
  <div className="absolute -top-24 -left-16 h-80 w-80 rounded-full bg-(--shell-accent)/[0.04] blur-2xl" />
  <div className="absolute -bottom-32 -right-12 h-96 w-96 rounded-full bg-(--shell-accent)/[0.03] blur-2xl" />
</div>
```

- [ ] **Step 2: AuthCard 组件**

`packages/web-common/src/shell/auth-card.tsx`：

```tsx
import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

/** auth 流程统一卡片：白底大圆角 + 双层阴影（近锐远柔）+ 内容淡入动效。 */
export function AuthCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "w-full rounded-2xl border border-foreground/[0.06] bg-background p-6 text-left",
        "shadow-[0_1px_2px_rgba(43,39,35,0.04),0_12px_32px_-12px_rgba(43,39,35,0.12)]",
        "animate-in fade-in slide-in-from-bottom-1 duration-200",
        className,
      )}
    >
      {children}
    </div>
  );
}
```

（若 `animate-in` 工具类不可用——本仓 Tailwind v4 无 tailwindcss-animate 时——改为在 `packages/web-common` 里补一个 keyframes 类：`@keyframes auth-card-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}`，类名 `[animation:auth-card-in_.2s_ease-out]`。实施时以 typecheck+页面实测为准。）

- [ ] **Step 3: 导出 + typecheck 两端**

`packages/web-common/src/shell/index.ts` 加 `export * from "./auth-card";`
Run: `pnpm --filter @meshbot/web-common build && pnpm --filter @meshbot/web-main typecheck && pnpm --filter @meshbot/web-agent typecheck`
Expected: 全 0 errors

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web-common): auth 视觉底座——光晕壳背景 + AuthCard 统一卡片"
```

---

### Task 5: WizardSteps 步骤指示 + 授权链提示条（web-main 登录/注册接入）

**Files:**
- Create: `apps/web-main/src/components/auth/wizard-steps.tsx`
- Create: `apps/web-main/src/components/auth/auth-chain-banner.tsx`
- Modify: `apps/web-main/src/app/login/page.tsx`
- Modify: `apps/web-main/src/app/register/page.tsx`
- Modify: `apps/web-main/messages/{zh,en}.json`

**Interfaces:**
- Produces:
  - `WizardSteps({ current, includeModel }: { current: "account"|"verify"|"org"|"model"|"device"; includeModel: boolean })`——受邀分支 `includeModel:false` 渲染四步。
  - `AuthChainBanner({ deviceName }: { deviceName?: string | null })`——检测到授权链时的浅橙提示条；`useAuthChainNext()` hook 返回 `{ next, requestId }`（从 `useSearchParams` 解析 `next` 是否指向 `/authorize`）。

- [ ] **Step 1: WizardSteps 组件**

```tsx
"use client";

import { cn } from "@meshbot/design";
import { useTranslations } from "next-intl";

export type WizardStep = "account" | "verify" | "org" | "model" | "device";

/** 注册授权向导步骤指示：受邀成员无模型写权限 → includeModel:false 渲染四步。 */
export function WizardSteps({
  current,
  includeModel,
}: {
  current: WizardStep;
  includeModel: boolean;
}) {
  const t = useTranslations("wizard");
  const steps: WizardStep[] = includeModel
    ? ["account", "verify", "org", "model", "device"]
    : ["account", "verify", "org", "device"];
  const idx = steps.indexOf(current);
  return (
    <ol className="mb-4 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>─</span>}
          <span
            className={cn(
              i < idx && "text-green-600",
              i === idx && "font-bold text-(--shell-accent)",
            )}
          >
            {i < idx ? "✓ " : ""}
            {t(`steps.${s}`)}
          </span>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 2: AuthChainBanner + useAuthChainNext**

`auth-chain-banner.tsx`：

```tsx
"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

/** 从 ?next= 判断当前登录/注册处于设备授权链中；返回 next 原串与 requestId。 */
export function useAuthChainNext(): {
  next: string | null;
  requestId: string | null;
} {
  const searchParams = useSearchParams();
  const next = searchParams.get("next");
  if (!next?.startsWith("/authorize")) return { next, requestId: null };
  const requestId = new URLSearchParams(next.split("?")[1] ?? "").get("request");
  return { next, requestId };
}

/** 授权链提示条：告知用户完成当前步后将继续设备授权。 */
export function AuthChainBanner() {
  const t = useTranslations("wizard");
  const { requestId } = useAuthChainNext();
  if (!requestId) return null;
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-(--shell-accent)/20 bg-(--shell-accent)/5 px-3 py-2 text-xs text-(--shell-accent)">
      ⚡ {t("chainBanner")}
    </div>
  );
}
```

- [ ] **Step 3: 登录/注册页接入**

- login 页卡片顶部：`<AuthChainBanner />`（登录不显示 WizardSteps——登录不是注册向导）。
- register 页卡片顶部：`<AuthChainBanner />` + `<WizardSteps current={step === "verify" ? "verify" : "account"} includeModel />`（注册时尚不知 owner/member，按五步展示；受邀分支在 authorize 页组织步之后动态四步——由 Task 7 的 authorize 侧 WizardSteps 处理）。
- 两页表单容器换 `AuthCard`（Task 4 产物），原 Card 样式类清理。

- [ ] **Step 4: i18n**

zh `wizard` 命名空间：`steps.account: "创建账号"`、`steps.verify: "邮箱验证"`、`steps.org: "组织"`、`steps.model: "模型"`、`steps.device: "设备授权"`、`chainBanner: "完成后将继续为你的设备授权"`；en 对应。`pnpm sync:locales -- --write`。

- [ ] **Step 5: typecheck + Commit**

Run: `pnpm --filter @meshbot/web-main typecheck`

```bash
git add -A && git commit -m "feat(web-main): 注册授权向导步骤指示 + 授权链提示条"
```

---

### Task 6: 桌面端登录页升级（三步示意 + 注册并授权本机）

**Files:**
- Modify: `apps/web-agent/src/app/login/page.tsx`
- Modify: `apps/web-agent/messages/{zh,en}.json`

**Interfaces:**
- Consumes: `startAuthorize(): Promise<{ requestId, authorizeUrl }>`（现有）；`useCloudWebUrl().data.webMainBase`（现有）。
- Produces: 「注册并授权本机」入口 —— `startAuthorize` 后打开 `{webMainBase}/register?next=${encodeURIComponent("/authorize?request=" + requestId)}` 并进入同一轮询等待态。

- [ ] **Step 1: 注册入口改造**

替换现有 `registerHref` 直链为带授权上下文的动作（复用 `beginPolling`）：

```tsx
const onRegisterWithAuthorize = async () => {
  if (!cloudWebUrl.data) return;
  setStartError(null);
  setStarting(true);
  try {
    const { requestId } = await startAuthorize();
    const next = encodeURIComponent(`/authorize?request=${requestId}`);
    window.open(
      `${cloudWebUrl.data.webMainBase}/register?next=${next}`,
      "_blank",
    );
    beginPolling(requestId);
  } catch (err) {
    setStartError(err instanceof Error ? err.message : t("startFailed"));
  } finally {
    setStarting(false);
  }
};
```

底部链接改按钮语义：`{t("noAccount")} <button onClick={onRegisterWithAuthorize}>{t("registerAndAuthorize")}</button>`。

- [ ] **Step 2: 三步流程示意 + 等待态升级**

idle 态标题下插入三步示意（图标圈 1/2/3 + 文案，弱化色，间隔点连接——照 mockup）；等待态改为脉冲圆环包浏览器 emoji/图标 + 现有取消/重开链接。样式全部 Tailwind 内联类，不新增组件文件（单页局部 UI）。核心结构：

```tsx
<div className="flex items-start justify-center gap-3 text-[10.5px] text-(--shell-sidebar-fg)/45">
  {[t("step1"), t("step2"), t("step3")].map((label, i) => (
    <div key={label} className="flex items-center gap-3">
      {i > 0 && <span className="mt-[-14px] tracking-[3px]">·····</span>}
      <div className="flex flex-col items-center gap-1.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-(--shell-line) bg-background text-(--shell-accent)">
          {i + 1}
        </span>
        {label}
      </div>
    </div>
  ))}
</div>
```

- [ ] **Step 3: i18n + typecheck**

zh：`registerAndAuthorize: "注册并授权本机"`、`step1: "点击授权"`、`step2: "浏览器确认"`、`step3: "自动登录"`；en 对应。`pnpm sync:locales -- --write` + `pnpm --filter @meshbot/web-agent typecheck`。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web-agent): 登录页三步示意 + 注册并授权本机（修注册断链）"
```

---

### Task 7: authorize 页向导化（组织/模型/确认 + 受邀分支）

**Files:**
- Create: `apps/web-main/src/components/auth/model-onboarding.tsx`
- Modify: `apps/web-main/src/app/authorize/page.tsx`
- Modify: `apps/web-main/src/components/auth/org-onboarding.tsx`（套 AuthCard 视觉 + 顶部 WizardSteps 由父层渲染，本组件仅内容）
- Modify: `apps/web-main/messages/{zh,en}.json`
- Test: `apps/web-main/src/components/auth/model-onboarding.spec.tsx`（若 web-main 无组件测试基建则以 authorize 步骤推导纯函数测试代替，见 Step 1）

**Interfaces:**
- Consumes: `useProfile()`（`activeOrg.role: "owner"|"member"`）、`useModelConfigs(orgId)`、`useCreateModelConfig(orgId)`（现有 REST hooks）、`WizardSteps`/`AuthChainBanner`（Task 5）、`AuthCard`（Task 4）。
- Produces:
  - `deriveAuthorizeStep(input): "org" | "model" | "device"` 纯函数（步骤推导，可测）：
    `{ hasOrg: boolean; role: "owner"|"member"|null; modelCount: number|null; modelSkipped: boolean }`
  - `ModelOnboarding({ orgId, onDone }: { orgId: string; onDone: () => void })`——简化模型表单，「跳过」也调 `onDone`。

- [ ] **Step 1（TDD）: 步骤推导纯函数 + 测试**

`apps/web-main/src/components/auth/authorize-step.ts`：

```ts
export type AuthorizeStep = "org" | "model" | "device";

/**
 * 授权页向导步骤推导：
 * - 无组织 → org
 * - owner 且组织零模型且未点跳过 → model（member 无模型写权限，直接 device）
 * - 其余 → device（确认卡）
 */
export function deriveAuthorizeStep(input: {
  hasOrg: boolean;
  role: "owner" | "member" | null;
  modelCount: number | null; // null = 加载中，视为已有（不闪模型步）
  modelSkipped: boolean;
}): AuthorizeStep {
  if (!input.hasOrg) return "org";
  if (
    input.role === "owner" &&
    input.modelCount === 0 &&
    !input.modelSkipped
  )
    return "model";
  return "device";
}
```

测试 `authorize-step.spec.ts`（放同目录；web-main 若 root jest 不收集，则加到既有测试收集路径——实施时以 `npx jest apps/web-main` 是否发现为准，不行就放 `libs` 式纯 ts 且在 root jest roots 内的位置——保持纯函数无 React 依赖即可随处收集）：

```ts
import { deriveAuthorizeStep } from "./authorize-step";

describe("deriveAuthorizeStep", () => {
  const base = { hasOrg: true, role: "owner" as const, modelCount: 1, modelSkipped: false };
  it("无组织 → org", () => {
    expect(deriveAuthorizeStep({ ...base, hasOrg: false })).toBe("org");
  });
  it("owner 零模型 → model", () => {
    expect(deriveAuthorizeStep({ ...base, modelCount: 0 })).toBe("model");
  });
  it("member 零模型 → device（受邀成员跳过模型步）", () => {
    expect(deriveAuthorizeStep({ ...base, role: "member", modelCount: 0 })).toBe("device");
  });
  it("owner 零模型但已跳过 → device", () => {
    expect(deriveAuthorizeStep({ ...base, modelCount: 0, modelSkipped: true })).toBe("device");
  });
  it("模型加载中(null)视为已有 → device 不闪模型步", () => {
    expect(deriveAuthorizeStep({ ...base, modelCount: null })).toBe("device");
  });
});
```

- [ ] **Step 2: ModelOnboarding 组件**

厂商预设 chip + Form/FormItem 简化表单（provider chip 只是填充 providerType/baseUrl 预设值的快捷方式，字段仍走共享 schema）：

```tsx
"use client";

const PROVIDER_PRESETS = [
  { key: "deepseek", label: "DeepSeek", providerType: "openai-compatible", baseUrl: "https://api.deepseek.com", placeholderModel: "deepseek-chat" },
  { key: "openai", label: "OpenAI", providerType: "openai", baseUrl: "", placeholderModel: "gpt-4o" },
  { key: "ollama", label: "Ollama", providerType: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", placeholderModel: "qwen3:8b" },
  { key: "custom", label: "自定义", providerType: "openai-compatible", baseUrl: "", placeholderModel: "" },
] as const;
```

表单字段：name（默认取模型名）、model、apiKey、baseUrl（custom 时展开）；提交调 `useCreateModelConfig(orgId)`（contextWindow 不传——云端 `resolveContextWindow` 自动解析，辅助行文案「上下文窗口将按模型自动识别，可稍后在设置中调整」）；成功与「跳过」都调 `onDone()`。PROVIDER_PRESETS 的 label 除「自定义」走 i18n 外为品牌名不翻译。

- [ ] **Step 3: authorize 页装配**

`AuthorizeFlow` 内加 `const [modelSkipped, setModelSkipped] = useState(false);` 与 `useModelConfigs(orgId)`（仅 owner 且有组织时启用查询），用 `deriveAuthorizeStep` 分派：

```tsx
const step = deriveAuthorizeStep({
  hasOrg: profile.data.activeOrg != null,
  role: profile.data.activeOrg?.role ?? null,
  modelCount: ownerModelQuery.data?.length ?? (ownerModelQueryEnabled ? null : 0),
  modelSkipped,
});
// step === "org"   → <OrgOnboarding />
// step === "model" → <ModelOnboarding orgId={...} onDone={() => setModelSkipped(true)} />
//                    （创建成功后 invalidate 使 modelCount>0，skipped 同样放行——onDone 统一置位即可）
// step === "device"→ 现有确认卡
```

页面统一结构：`<AuthChainBanner />`（authorize 页恒显示设备名——从 `request.deviceName` 传入优先于 hook）+ `<WizardSteps current={stepToWizard(step)} includeModel={profile.data.activeOrg?.role !== "member"} />` + `<AuthCard>{stepContent}</AuthCard>`；确认卡设备信息改结构化小卡（💻 图标 + 设备名/平台/组织三行，照 mockup）。

- [ ] **Step 4: i18n + 测试 + typecheck**

`pnpm sync:locales -- --write`；`npx jest <authorize-step 测试路径>`；`pnpm --filter @meshbot/web-main typecheck`。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web-main): authorize 页向导化——组织/模型/确认三步 + 受邀成员跳过模型步"
```

---

### Task 8: Skeleton 组件 + loading-states 技能 + authorize 骨架示范

**Files:**
- Create: `packages/design/src/components/ui/skeleton.tsx`
- Modify: `packages/design/src/index.ts`（或该包现有导出入口，实施时以 `grep -n "alert" packages/design/src/index.ts` 找到同类导出行照加）
- Create: `.claude/skills/loading-states/SKILL.md`
- Modify: `apps/web-main/src/app/authorize/page.tsx`（首载大 spinner → 卡片骨架）

**Interfaces:**
- Produces: `Skeleton({ className })`——`animate-pulse rounded-md bg-muted` 基础块，形状全靠调用方 className（宽高圆角），不做变体组件（YAGNI：文本行/圆形用 className 即可）。

- [ ] **Step 1: Skeleton 组件**

```tsx
import { cn } from "../../lib/utils";

/** 骨架屏基础块：形状由调用方 className 决定（h-4 w-32 / h-10 w-10 rounded-full…）。 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("animate-pulse rounded-md bg-muted", className)} />
  );
}
```

（`cn` 的相对导入路径以该包内 alert.tsx 等现有组件的写法为准。）导出加入包入口。

- [ ] **Step 2: authorize 页骨架示范**

首载分支（profile/deviceAuthQuery pending）从大 spinner 改为：

```tsx
<AuthCard className="flex flex-col gap-3">
  <Skeleton className="h-5 w-32" />
  <Skeleton className="h-4 w-56" />
  <div className="flex gap-3 rounded-xl border border-border/60 p-3">
    <Skeleton className="h-9 w-9 rounded-lg" />
    <div className="flex flex-1 flex-col gap-2">
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className="h-3 w-28" />
    </div>
  </div>
  <div className="flex gap-2">
    <Skeleton className="h-10 flex-1 rounded-lg" />
    <Skeleton className="h-10 flex-1 rounded-lg" />
  </div>
</AuthCard>
```

- [ ] **Step 3: loading-states 技能**

`.claude/skills/loading-states/SKILL.md`：

```markdown
---
name: loading-states
description: 写前端加载态（页面首载/按钮请求/数据刷新）时的规范——何时骨架屏、何时内联 spinner、何时静默刷新
---

# 加载态规范

## 三条规则

1. **整页 / 大区块首载 → 骨架屏**。用 `@meshbot/design` 的 `Skeleton`，
   形状贴近真实内容（标题行/头像/按钮各归其位），禁止整页大 spinner。
   参考示范：`apps/web-main/src/app/authorize/page.tsx` 首载分支。
2. **按钮 / 小操作请求 → 按钮内联 spinner + disabled**。文案左侧
   `<Loader2 className="h-3.5 w-3.5 animate-spin" />`，不弹遮罩、不换按钮尺寸。
3. **已有数据的刷新 → 静默后台更新**。React Query 的 refetch 不显示加载态，
   不闪骨架（`isPending` 才骨架，`isFetching` 不骨架）。

## 反模式

- 全屏 spinner 盖住已渲染内容
- 骨架形状与真实内容布局无关（一根孤零零的长条）
- mutation pending 时把按钮换成独立 spinner 元素（布局跳动）
```

- [ ] **Step 4: build + typecheck + Commit**

Run: `pnpm --filter @meshbot/design build && pnpm --filter @meshbot/web-main typecheck`

```bash
git add -A && git commit -m "feat(design): Skeleton 组件 + loading-states 技能 + authorize 骨架示范"
```

---

### Task 9: 全量回归 + 终验准备

**Files:**
- Modify: 无（验证性 Task；发现问题回对应 Task 修）

- [ ] **Step 1: 全量验证**

```bash
pnpm typecheck          # 全仓 0 错
npx jest apps/server-agent apps/server-main/src libs/main libs/common   # 全绿
pnpm check              # 九围栏
pnpm sync:locales       # missing=0
```

- [ ] **Step 2: 生效构建**

```bash
pnpm build:server-main            # 云端（nest watch 会自动重启）
cd apps/desktop && pnpm run pack  # 桌面新包
pnpm rebuild better-sqlite3       # pack 会污染根 ABI，必须恢复（见 memory）
```

- [ ] **Step 3: Commit（若有零星修正）+ 终验清单交用户**

终验（眼验，需用户）：
- [ ] 路径 1 已登录：桌面端点授权 → 浏览器确认卡（结构化设备信息）→ 批准 → 「正在完成授权…」→ 品牌化成功页（对勾动画/自动关）→ 桌面端已登录；全程不见授权码
- [ ] 路径 2 未登录：跳登录页（带授权链提示条）→ 登录 → 回确认卡 → 同上
- [ ] 路径 3 全新注册（owner）：桌面端「注册并授权本机」→ 五步向导（账号→验证→建组织→模型[chip 预设/自动上下文]→确认）→ 桌面端登录成功
- [ ] 路径 3b 受邀注册（member）：组织步粘邀请码 → 步骤指示变四步、无模型步 → 确认 → 完成
- [ ] 路径 4 兜底：批准后杀掉桌面端进程使 loopback 失败 → 浏览器退回 → 黄条+授权码卡 → 重启桌面端手动输码成功
- [ ] 模型步「跳过」→ 授权完成 → 桌面端 ModelSetupGate 引导出现
- [ ] 视觉：光晕背景/卡片阴影/步骤指示/切换动效/骨架屏（authorize 首载刷新可见）
- [ ] TTL：注册链路耗时 >10 分钟 <30 分钟仍能完成授权

## 回归结论

<!-- 终验通过后填写 -->
