# web-main 登录后前置引导门（OnboardingGate）实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** web-main 登录/注册成功后，把「有组织」「组织有模型配置」作为进入 app 的前置门：无组织→复用 OrgOnboarding，无模型→owner 就地配置/非 owner 只读拦截，都满足才放行 (shell)。

**Architecture:** 在 `(shell)/layout.tsx` 内用一个客户端 `OnboardingGate` 包住 children（AuthGuard 已保证已登录）；门的分步决策抽成零依赖纯函数 `resolveOnboardingStep`（可单测）；组织步复用现成 `OrgOnboarding`，owner 模型步复用从 `settings/models` 抽出的共享 `ModelFormPanel`，非 owner 走只读拦截。各 mutation 成功 invalidate 对应 query → 门自动重算前进。

**Tech Stack:** Next 16 (App Router) + React 19 + @tanstack/react-query + next-intl + `@meshbot/design`（Form/FormItem/useSchema）+ `@meshbot/types-main`。

**Spec:** `docs/superpowers/specs/2026-07-09-web-main-onboarding-gate-design.md`

## Global Constraints

- 只 gate `(shell)` 已认证路由；**不改** register/login 落地目标（仍 `/assistant`）、**不改** `AuthGuard` 鉴权判定、**不动** `/authorize` 支线与 web-agent。
- 模型配置后端 **owner 限定**：`activeOrg.role === "owner"` → 配置表单；`"member"` → 只读拦截（`OrgRole = "owner" | "member"`，无 admin）。
- **加载优先级防闪烁**：profile 或 model-configs 任一 loading → 统一渲染加载态，绝不先闪 app / 先闪错步。
- **DRY**：组织步复用 `OrgOnboarding`；owner 模型步复用抽出的 `ModelFormPanel`，不重写表单。
- 所有用户可见文案走 next-intl，**禁止裸字符串**；新增 key 必须 en/zh 双语同步（`pnpm` i18n 对齐围栏会校验）。
- 纯逻辑测试用根 jest（`apps/**/*.spec.ts` 已在 testMatch），纯模块用**相对 import**（勿用 `@/`——根 jest 的 `@/` alias 指向 web-agent）；不引入新测试栈。
- 提交中文 conventional commits，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## 文件结构

- Create `apps/web-main/src/components/auth/onboarding-step.ts` — 纯决策函数 + 类型（零 React 依赖）。
- Create `apps/web-main/src/components/auth/onboarding-step.spec.ts` — 纯逻辑单测。
- Create `apps/web-main/src/components/models/model-form-panel.tsx` — 从 settings/models 抽出的共享创建/编辑表单 + `buildFormSchema` + `PROVIDERS` + 行辅助 + `modelFormValuesToCreateInput` 映射。
- Modify `apps/web-main/src/app/(shell)/settings/models/page.tsx` — 改为从上面共享模块 import（移除被抽走的定义），行为不变。
- Create `apps/web-main/src/components/auth/onboarding-gate.tsx` — `OnboardingGate` + 内联 owner 模型步 + 非 owner 只读拦截。
- Modify `apps/web-main/src/app/(shell)/layout.tsx` — 用 `<OnboardingGate>` 包 children。
- Modify `apps/web-main/messages/en.json` + `apps/web-main/messages/zh.json` — 新增 `onboarding` 命名空间 key（实现时确认这两个 locale 文件的实际路径/结构，照现有格式加）。

---

### Task 1: `resolveOnboardingStep` 决策纯函数 + 单测

**Files:**
- Create: `apps/web-main/src/components/auth/onboarding-step.ts`
- Create: `apps/web-main/src/components/auth/onboarding-step.spec.ts`

**Interfaces:**
- Produces: `type OnboardingStep = "loading" | "org" | "model-owner" | "model-blocked" | "ready"`；`resolveOnboardingStep(input): OnboardingStep`（供 Task 3 的 `OnboardingGate` 消费）。

- [ ] **Step 1: 先写失败单测 `onboarding-step.spec.ts`**（相对 import，勿用 `@/`）

```ts
import { resolveOnboardingStep } from "./onboarding-step";

const base = {
  profileLoading: false,
  activeOrg: null as { role: "owner" | "member" } | null,
  modelConfigsLoading: false,
  modelConfigCount: 0,
};

describe("resolveOnboardingStep", () => {
  it("profile 加载中 → loading（最高优先级）", () => {
    expect(resolveOnboardingStep({ ...base, profileLoading: true })).toBe("loading");
  });
  it("无 activeOrg → org", () => {
    expect(resolveOnboardingStep({ ...base, activeOrg: null })).toBe("org");
  });
  it("有 org 但模型列表加载中 → loading", () => {
    expect(
      resolveOnboardingStep({ ...base, activeOrg: { role: "owner" }, modelConfigsLoading: true }),
    ).toBe("loading");
  });
  it("有 org 且有模型 → ready", () => {
    expect(
      resolveOnboardingStep({ ...base, activeOrg: { role: "member" }, modelConfigCount: 2 }),
    ).toBe("ready");
  });
  it("有 org 无模型 + owner → model-owner", () => {
    expect(
      resolveOnboardingStep({ ...base, activeOrg: { role: "owner" }, modelConfigCount: 0 }),
    ).toBe("model-owner");
  });
  it("有 org 无模型 + member → model-blocked", () => {
    expect(
      resolveOnboardingStep({ ...base, activeOrg: { role: "member" }, modelConfigCount: 0 }),
    ).toBe("model-blocked");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（仓库根）：`pnpm exec jest apps/web-main/src/components/auth/onboarding-step.spec.ts`
Expected: FAIL（模块/函数不存在）。

- [ ] **Step 3: 实现 `onboarding-step.ts`**

```ts
import type { OrgRole } from "@meshbot/types-main";

export type OnboardingStep =
  | "loading"
  | "org"
  | "model-owner"
  | "model-blocked"
  | "ready";

export interface OnboardingStepInput {
  /** profile query 加载中。 */
  profileLoading: boolean;
  /** 当前活跃组织（含角色）；无组织为 null。 */
  activeOrg: { role: OrgRole } | null;
  /** 模型配置列表加载中（仅在有 activeOrg 时有意义，调用方据此传值）。 */
  modelConfigsLoading: boolean;
  /** 当前组织的模型配置数量。 */
  modelConfigCount: number;
}

/**
 * 登录后前置门分步决策（纯函数，便于单测）：
 * profile 加载中 → loading；无组织 → org；组织模型列表加载中 → loading；
 * 有模型 → ready；无模型且 owner → model-owner；无模型且非 owner → model-blocked。
 */
export function resolveOnboardingStep(input: OnboardingStepInput): OnboardingStep {
  if (input.profileLoading) return "loading";
  if (input.activeOrg == null) return "org";
  if (input.modelConfigsLoading) return "loading";
  if (input.modelConfigCount > 0) return "ready";
  return input.activeOrg.role === "owner" ? "model-owner" : "model-blocked";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec jest apps/web-main/src/components/auth/onboarding-step.spec.ts`
Expected: PASS（6 用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/web-main/src/components/auth/onboarding-step.ts apps/web-main/src/components/auth/onboarding-step.spec.ts
git commit -m "feat(web-main): 前置门分步决策纯函数 resolveOnboardingStep + 单测

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 抽出共享 `ModelFormPanel`（供 settings/models 与 OnboardingGate 复用）

**Files:**
- Create: `apps/web-main/src/components/models/model-form-panel.tsx`
- Modify: `apps/web-main/src/app/(shell)/settings/models/page.tsx`

**Interfaces:**
- Produces（从现 `settings/models/page.tsx` 原样搬出并导出，签名不变）：
  - `ModelFormPanel`（props：`{ mode: "create" | "edit"; initial: OrgModelConfigView | null; onCancel: () => void; onSubmit: (values: ModelFormValues) => Promise<void>; submitting: boolean; error: string | null }`）
  - `type ModelFormValues`（`z.infer<ReturnType<typeof buildFormSchema>>`）
  - `modelFormValuesToCreateInput(values: ModelFormValues): OrgModelConfigCreateInput` —— 把现在 `settings/models/page.tsx` 的 `handleSubmit` 里「create 分支」表单值→API 入参的映射逻辑抽成纯函数导出（Task 3 owner 模型步复用；settings 页 create 分支也改用它）。

- [ ] **Step 1: 读现状**：`apps/web-main/src/app/(shell)/settings/models/page.tsx`（463 行）里的 `ModelFormPanel`（函数 + `ModelFormPanelProps`）、`buildFormSchema`、`ModelFormValues`、`PROVIDERS` 常量、以及那个「不能直接当 FormItem 子节点」的输入行辅助组件（文件头部注释提到）、`handleSubmit` 里 create 分支的值→`OrgModelConfigCreateInput` 映射。

- [ ] **Step 2: 新建 `components/models/model-form-panel.tsx`**：把上述定义**原样移入**（`"use client"`；import 从 page 里那批 `@meshbot/design`/`@meshbot/types-main`/`useCreateModelConfig` 相关按需带过来），并 `export` `ModelFormPanel`、`ModelFormValues`、`buildFormSchema`（若 settings 页别处仍用）、`modelFormValuesToCreateInput`。映射函数示例（按现 handleSubmit create 分支的实际转换实现，字段以现 schema 为准）：

```ts
// 依据现 settings/models handleSubmit 的 create 分支转换（contextWindow 字符串→number、空串→undefined 等）
export function modelFormValuesToCreateInput(values: ModelFormValues): OrgModelConfigCreateInput {
  return {
    name: values.name,
    providerType: values.providerType,
    model: values.model,
    apiKey: values.apiKey,
    baseUrl: values.baseUrl || undefined,
    contextWindow: values.contextWindow ? Number(values.contextWindow) : undefined,
  };
}
```
> 以现有 `handleSubmit` 的确切映射为准（若有额外字段/裁剪，照搬），保证 settings 页行为零变化。

- [ ] **Step 3: 改 `settings/models/page.tsx`**：删除已移走的 `ModelFormPanel`/`buildFormSchema`/`PROVIDERS`/行辅助/`ModelFormValues` 定义，改为从 `@/components/models/model-form-panel` import；create 分支的映射改用 `modelFormValuesToCreateInput`。其余（列表/编辑/删除/owner 判定/ConfirmDialog）不动。

- [ ] **Step 4: 验证 typecheck + settings 页行为不变**

Run: `npx turbo run typecheck --filter=@meshbot/web-main`
Expected: PASS。
（像素/交互层面 settings/models 页与改前一致——create/edit 面板、字段、保存、owner 限定；本任务是纯抽取，无行为变化，最终由 Task 4 眼验时一并确认。）

- [ ] **Step 5: 提交**

```bash
git add apps/web-main/src/components/models/model-form-panel.tsx "apps/web-main/src/app/(shell)/settings/models/page.tsx"
git commit -m "refactor(web-main): 抽出共享 ModelFormPanel（settings/models 与 OnboardingGate 复用）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `OnboardingGate` 组件（org 步 / owner 模型步 / 非 owner 拦截）+ i18n

**Files:**
- Create: `apps/web-main/src/components/auth/onboarding-gate.tsx`
- Modify: `apps/web-main/messages/en.json`、`apps/web-main/messages/zh.json`

**Interfaces:**
- Consumes: `resolveOnboardingStep`（Task 1）、`ModelFormPanel` + `modelFormValuesToCreateInput` + `ModelFormValues`（Task 2）、`useProfile`（`@/rest/auth`）、`useModelConfigs`/`useCreateModelConfig`（`@/rest/model-config`）、`OrgOnboarding`（`@/components/auth/org-onboarding`）。
- Produces: `OnboardingGate`（props：`{ children: ReactNode }`），供 Task 4 挂载。

- [ ] **Step 1: 新增 i18n key（en.json + zh.json 都加，命名空间 `onboarding`）**

en.json（并入现有结构；键值示例）：
```json
"onboarding": {
  "modelStepTitle": "Configure a model",
  "modelStepDesc": "Add a model configuration for your organization to start using MeshBot.",
  "modelBlockedTitle": "No model configured yet",
  "modelBlockedDesc": "Ask your organization owner to configure a model, then refresh.",
  "refresh": "Refresh"
}
```
zh.json：
```json
"onboarding": {
  "modelStepTitle": "配置模型",
  "modelStepDesc": "为你的组织添加一个模型配置，即可开始使用 MeshBot。",
  "modelBlockedTitle": "尚未配置模型",
  "modelBlockedDesc": "请联系组织 owner 配置模型后刷新。",
  "refresh": "刷新"
}
```
> 加完确认 en/zh 键集完全一致（i18n 对齐围栏会校验 missing/asymmetric=0）。

- [ ] **Step 2: 实现 `onboarding-gate.tsx`**

```tsx
"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useState } from "react";
import { OrgOnboarding } from "@/components/auth/org-onboarding";
import { resolveOnboardingStep } from "@/components/auth/onboarding-step";
import {
  ModelFormPanel,
  modelFormValuesToCreateInput,
  type ModelFormValues,
} from "@/components/models/model-form-panel";
import { ApiError } from "@/lib/api";
import { useProfile } from "@/rest/auth";
import { useCreateModelConfig, useModelConfigs } from "@/rest/model-config";

/** 居中加载态（复用 AuthGuard 同款 spinner 风格）。 */
function GateLoading() {
  const t = useTranslations("common");
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div
        role="status"
        aria-label={t("loading")}
        className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
      />
    </div>
  );
}

/** owner：就地建首个模型配置。成功后 useCreateModelConfig 会 invalidate 列表 → 门重算放行。 */
function ModelOwnerStep({ orgId }: { orgId: string }) {
  const t = useTranslations("onboarding");
  const create = useCreateModelConfig(orgId);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (values: ModelFormValues) => {
    setError(null);
    try {
      await create.mutateAsync(modelFormValuesToCreateInput(values));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-4">
      <div>
        <h1 className="text-lg font-semibold">{t("modelStepTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("modelStepDesc")}</p>
      </div>
      <ModelFormPanel
        mode="create"
        initial={null}
        onCancel={() => {}}
        onSubmit={onSubmit}
        submitting={create.isPending}
        error={error}
      />
    </div>
  );
}

/** 非 owner 且组织无模型：只读拦截，提示联系 owner；提供刷新（重拉 profile+模型）。 */
function ModelBlocked() {
  const t = useTranslations("onboarding");
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-lg font-semibold">{t("modelBlockedTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("modelBlockedDesc")}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
      >
        {t("refresh")}
      </button>
    </div>
  );
}

/**
 * 登录后前置引导门：AuthGuard 已保证登录；此门按 组织/模型 状态决定就地引导或放行。
 * 挂在 (shell)/layout，包住全部 app 路由——门本身就地提供 org/model UI，被拦时无需访问其它页。
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const profile = useProfile();
  const activeOrg = profile.data?.activeOrg ?? null;
  const models = useModelConfigs(activeOrg?.id ?? null);

  const step = resolveOnboardingStep({
    profileLoading: profile.isPending,
    activeOrg: activeOrg ? { role: activeOrg.role } : null,
    modelConfigsLoading: activeOrg != null && models.isPending,
    modelConfigCount: models.data?.length ?? 0,
  });

  switch (step) {
    case "loading":
      return <GateLoading />;
    case "org":
      return <OrgOnboarding />;
    case "model-owner":
      // activeOrg 必非空（step 为 model-owner 时）
      return <ModelOwnerStep orgId={activeOrg!.id} />;
    case "model-blocked":
      return <ModelBlocked />;
    default:
      return <>{children}</>;
  }
}
```

> 确认 `ApiError` 从 `@/lib/api` 导出（org-onboarding.tsx 已这么用）。若 `ModelFormPanel` 的 Cancel 按钮在 onboarding 语境下多余，可后续给它加可选 `hideCancel`，本任务先传 no-op `onCancel`。

- [ ] **Step 3: 验证 typecheck + i18n 对齐**

Run: `npx turbo run typecheck --filter=@meshbot/web-main`
Expected: PASS。
Run（i18n 对齐，命令以仓库现有为准，如）：`pnpm exec tsx scripts/sync-locales.ts -- --check`
Expected: `missing=0, asymmetric=0`（web-main 段）。

- [ ] **Step 4: 提交**

```bash
git add apps/web-main/src/components/auth/onboarding-gate.tsx apps/web-main/messages/en.json apps/web-main/messages/zh.json
git commit -m "feat(web-main): OnboardingGate（组织/模型前置门）+ i18n

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 挂载到 `(shell)/layout.tsx` + 端到端眼验

**Files:**
- Modify: `apps/web-main/src/app/(shell)/layout.tsx`

**Interfaces:**
- Consumes: `OnboardingGate`（Task 3）。

- [ ] **Step 1: 用 `OnboardingGate` 包住 (shell) children**

```tsx
import type { ReactNode } from "react";
import { OnboardingGate } from "@/components/auth/onboarding-gate";
import { WorkspaceRail } from "@/components/shell/workspace-rail";

/** (shell) 段持久壳:深 rail + 内容区。鉴权由根 Providers 的 AuthGuard 负责；
 *  组织/模型前置引导由 OnboardingGate 负责（缺失时就地引导，满足才渲染 app）。 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-(--shell-chrome) text-foreground">
      <WorkspaceRail />
      <div className="min-h-0 flex-1 overflow-hidden pr-1.5 pb-1.5 pt-1.5">
        <OnboardingGate>{children}</OnboardingGate>
      </div>
    </div>
  );
}
```
> 注：`(shell)/layout.tsx` 是 server 组件，渲染客户端 `OnboardingGate` 并透传 children 是合法的（RSC → client boundary）。门放在内容区里、rail 之外——被引导时 rail 仍在（属可接受；若要连 rail 一起挡，可把 OnboardingGate 提到最外层包 rail+内容，本任务先按内容区内挂，眼验后按需调整）。

- [ ] **Step 2: typecheck**

Run: `npx turbo run typecheck --filter=@meshbot/web-main`
Expected: PASS。

- [ ] **Step 3: 端到端眼验（跑 web-main + server-main 后端）**

Run（仓库根，注意 web-main dev 端口 3002；server-main 提供 org/模型/profile 接口）：
```
pnpm dev:server-main   # 后端
pnpm dev:web-main      # :3002
```
浏览器 `http://localhost:3002` 走验收（对照 spec §7）：
- 新注册用户（无 org）→ 落地即见组织引导（创建/加入），不进首页；
- 创建组织成 owner → 见模型配置步；配成首个模型 → 进首页；
- 粘贴邀请码加入**已有模型**组织 → 直接进首页；
- 非 owner 加入**无模型**组织 → 见只读「请联系 owner」拦截，不进首页、不报 403；
- 已完成 org+模型 老用户 → 登录后直达首页（门透明放行）；
- 全程无「先闪首页/先闪错步」的加载抖动。

Expected: 上述逐条符合。

- [ ] **Step 4: 提交**

```bash
git add "apps/web-main/src/app/(shell)/layout.tsx"
git commit -m "feat(web-main): (shell) 挂载 OnboardingGate 启用登录后前置引导门

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 自检（对照 spec）

- spec §3.1 OnboardingGate（shell 层条件渲染门、分步逻辑、invalidate 自动前进）→ Task 3 + Task 4 ✅
- spec §3.2 `resolveOnboardingStep` 纯函数 + 单测 → Task 1 ✅
- spec §3.3 组织步复用 OrgOnboarding → Task 3（`case "org"`）✅
- spec §3.4 owner 模型步复用表单 → Task 2（抽 ModelFormPanel）+ Task 3（ModelOwnerStep）✅
- spec §3.5 非 owner 只读拦截 → Task 3（ModelBlocked）✅
- spec §4 数据流（useProfile + useModelConfigs enabled + invalidate）→ Task 3 ✅
- spec §5 不做（不改落地/AuthGuard/authorize/web-agent）→ Global Constraints + 各任务范围 ✅
- spec §6 测试（纯逻辑单测 + 跑 web-main 眼验）→ Task 1 单测 + Task 4 Step 3 ✅
- spec §7 验收 6 条 → Task 4 Step 3 ✅
- spec §8 风险（加载闪烁 loading 优先、表单复用不拖管理逻辑）→ Task 1 loading 优先 + Task 2 只抽表单 ✅

类型/命名一致性：`OnboardingStep`/`resolveOnboardingStep`/`OnboardingStepInput`（Task 1）、`ModelFormPanel`/`ModelFormValues`/`modelFormValuesToCreateInput`（Task 2）、`OnboardingGate`（Task 3）在各任务间一致引用。
