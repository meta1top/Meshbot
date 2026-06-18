# Auth 路由梳理：登录后模型配置布局级守卫 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复直接登录（已有账号但未配置模型）时应用崩溃的问题——将模型配置检查提升到布局层，任何已登录路由若检测到未配置模型，都显示模型配置页面而非放行。

**Architecture:** 在 `AuthGuard` 中新增第二道检查：用户已认证且不在登录前路由（`/login`、`/setup`）时，查询 `["model-configs"]`；若返回空列表，渲染 `ModelSetupOverlay` 全屏覆盖层代替 children，完成配置后自动重渲。同时将 `setup/page.tsx` 中内联的模型步骤 UI 抽取为独立组件 `ModelStep`，供 `setup/page.tsx` 和新覆盖层复用。

**Tech Stack:** Next.js App Router、React Query (`useQuery`)、Jotai、React (`useState`/`useEffect`)、next-intl

## Global Constraints

- 所有新增/修改文件必须通过 `pnpm typecheck`（无 TS 错误）
- 每次代码变更后运行 `pnpm format`（Biome）
- 不新增 i18n 键——复用 `setup` 命名空间现有键
- 不引入新依赖
- 不修改后端代码
- pre-login 路由定义：`/login`、`/setup`（含其子步骤）

---

## 文件结构

| 操作 | 路径 | 职责 |
|------|------|------|
| **新建** | `apps/web-agent/src/components/setup/model-step.tsx` | 独立的模型配置步骤组件（Provider 选择 + ModelForm），接收 `onDone` 回调 |
| **新建** | `apps/web-agent/src/components/model-setup-overlay.tsx` | 全屏模型配置覆盖层，使用 AuthShellLayout + ModelStep，完成后 invalidate model-configs 缓存 |
| **修改** | `apps/web-agent/src/app/setup/page.tsx` | 删除内联模型步骤 UI，改用 `<ModelStep onDone={...} />` |
| **修改** | `apps/web-agent/src/components/auth-guard.tsx` | 认证后追加 model-configs 检查，无模型时渲染 ModelSetupOverlay |
| **修改** | `apps/web-agent/src/app/login/page.tsx` | 登录成功后仅在 `needs-org` 时跳 `/setup`，其余统一跳 `/assistant`（AuthGuard 接管模型检查） |

---

### Task 1: 抽取 ModelStep 组件

**Files:**
- Create: `apps/web-agent/src/components/setup/model-step.tsx`
- Modify: `apps/web-agent/src/app/setup/page.tsx`

**Interfaces:**
- Produces: `export function ModelStep({ onDone }: { onDone: () => void }): JSX.Element`

- [ ] **Step 1: 创建 `model-step.tsx`**

将 `setup/page.tsx` 中 Provider 选择 + ModelForm 的完整 JSX 迁移到新文件，调整依赖后如下：

```tsx
// apps/web-agent/src/components/setup/model-step.tsx
"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@meshbot/design";
import type { ModelConfigInput, ProviderDef } from "@meshbot/web-common";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  siAnthropic,
  siDeepseek,
  siGooglegemini,
  siOllama,
  siOpenaigym,
  siOpenrouter,
} from "simple-icons";
import ModelForm from "@/components/setup/model-form";
import { useCreateModelConfig, useProviders } from "@/rest/model-config";

type SimpleIconLike = { path: string; hex: string };

const PROVIDER_ICON_MAP: Record<string, SimpleIconLike> = {
  openai: siOpenaigym,
  anthropic: siAnthropic,
  google: siGooglegemini,
  deepseek: siDeepseek,
  ollama: siOllama,
  "openai-compatible": siOpenrouter,
};

function ProviderOption({ provider }: { provider: ProviderDef }) {
  const icon = PROVIDER_ICON_MAP[provider.type];
  return (
    <div className="flex w-full min-w-0 items-center gap-2.5">
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
        {icon ? (
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            role="img"
            aria-hidden="true"
            style={{ color: `#${icon.hex}` }}
          >
            <path d={icon.path} fill="currentColor" />
          </svg>
        ) : (
          <span className="text-[10px] font-semibold tracking-wide text-muted-foreground">
            {provider.name.slice(0, 2).toUpperCase()}
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-current">
          {provider.name}
        </p>
        <p className="truncate text-xs leading-5 text-current/70">
          {provider.description}
        </p>
      </div>
    </div>
  );
}

interface ModelStepProps {
  onDone: () => void;
}

export function ModelStep({ onDone }: ModelStepProps) {
  const t = useTranslations("setup");
  const { data: providers = [] } = useProviders();
  const createModelMutation = useCreateModelConfig();
  const [selected, setSelected] = useState<ProviderDef | null>(null);

  useEffect(() => {
    if (!selected && providers.length > 0) {
      setSelected(providers[0] ?? null);
    }
  }, [providers, selected]);

  const handleSubmit = async (data: ModelConfigInput) => {
    await createModelMutation.mutateAsync(data);
    onDone();
  };

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle>{t("chooseProvider")}</CardTitle>
        <CardDescription>{t("chooseProviderDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="pt-3">
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground">
              {t("provider")}
            </p>
            <Select
              value={selected?.type ?? ""}
              onValueChange={(type) => {
                const provider = providers.find((item) => item.type === type);
                setSelected(provider ?? null);
              }}
            >
              <SelectTrigger className="h-12 px-3 text-left [&>span]:flex [&>span]:w-full [&>span]:items-center [&>span]:text-left [&>svg]:text-muted-foreground">
                {selected ? (
                  <ProviderOption provider={selected} />
                ) : (
                  <span className="text-sm text-muted-foreground">
                    {t("chooseProviderPlaceholder")}
                  </span>
                )}
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem
                    key={provider.type}
                    value={provider.type}
                    className="py-2.5 pr-9"
                  >
                    <ProviderOption provider={provider} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selected ? (
            <div className="pr-1">
              <h3 className="mb-3 border-t border-border pt-4 text-sm font-semibold tracking-wide text-foreground/80">
                {t("modelConfig")}
              </h3>
              <ModelForm
                key={selected.type}
                provider={selected}
                onSubmit={handleSubmit}
                submitting={createModelMutation.isPending}
                error={
                  createModelMutation.error instanceof Error
                    ? createModelMutation.error.message
                    : createModelMutation.error
                      ? t("saveFailed")
                      : null
                }
              />
            </div>
          ) : (
            <div className="flex min-h-[220px] items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
              {t("chooseProviderToStart")}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: 修改 `setup/page.tsx` — 删除内联模型步骤，改用 ModelStep**

删除以下内容：
- `SimpleIconLike` 类型、`PROVIDER_ICON_MAP` 常量、`ProviderOption` 函数
- `selected` state 和 `useEffect(() => { if (step === "model" && !selected ...) }, ...)`
- `handleModelSubmit` 函数
- `createModelMutation`、`useCreateModelConfig`、`useProviders` 的引用
- imports：`Select`、`SelectContent`、`SelectItem`、`SelectTrigger`（来自 design）、`ModelForm`、`ProviderDef`、`ModelConfigInput`（来自 web-common）、`si*`（来自 simple-icons）、`useCreateModelConfig`、`useProviders`

新增 import：
```tsx
import { ModelStep } from "@/components/setup/model-step";
```

将 `{step === "model" && ( <Card>...大段 JSX...</Card> )}` 替换为：

```tsx
{step === "model" && (
  <ModelStep
    onDone={() => {
      queryClient.invalidateQueries({ queryKey: ["auth", "status"] });
      router.push("/assistant");
    }}
  />
)}
```

- [ ] **Step 3: 运行类型检查和格式化**

```bash
cd /Users/grant/Meta1/meshbot
pnpm typecheck 2>&1 | head -50
pnpm format
```

预期：无 TS 错误，格式化通过。

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/src/components/setup/model-step.tsx apps/web-agent/src/app/setup/page.tsx
git commit -m "refactor(web-agent): 抽取 ModelStep 为独立组件，供 setup 向导与覆盖层复用"
```

---

### Task 2: 创建 ModelSetupOverlay 全屏覆盖层

**Files:**
- Create: `apps/web-agent/src/components/model-setup-overlay.tsx`

**Interfaces:**
- Consumes: `ModelStep` from Task 1（`onDone` 回调触发 invalidate）
- Produces: `export function ModelSetupOverlay(): JSX.Element`

- [ ] **Step 1: 创建 `model-setup-overlay.tsx`**

```tsx
// apps/web-agent/src/components/model-setup-overlay.tsx
"use client";

import { useTranslations } from "next-intl";
import { AuthShellLayout } from "@/components/layouts/auth-shell-layout";
import { ModelStep } from "@/components/setup/model-step";

/**
 * 已登录但未配置模型时的全屏引导页。
 * 完成后由 AuthGuard 中的 model-configs 查询自动检测到有模型而切换到正常内容，
 * 无需手动 redirect。
 */
export function ModelSetupOverlay() {
  const t = useTranslations("setup");

  return (
    <AuthShellLayout>
      <div className="w-full max-w-[420px]">
        <div className="pr-1">
          <span className="mb-4 inline-flex items-center rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
            {t("getStarted")}
          </span>
          {/* onDone 无需额外操作：useCreateModelConfig 的 onSuccess 已自动
              invalidate ["model-configs"]，AuthGuard 会重渲并放行正常内容。 */}
          <ModelStep onDone={() => {}} />
        </div>
      </div>
    </AuthShellLayout>
  );
}
```

- [ ] **Step 2: 运行格式化**

```bash
cd /Users/grant/Meta1/meshbot && pnpm format
```

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/components/model-setup-overlay.tsx
git commit -m "feat(web-agent): 新增 ModelSetupOverlay 全屏模型配置覆盖层"
```

---

### Task 3: 修改 AuthGuard — 认证后追加模型配置守卫

**Files:**
- Modify: `apps/web-agent/src/components/auth-guard.tsx`

**Interfaces:**
- Consumes: `ModelSetupOverlay` from Task 2、`fetchModelConfigs` from `@/rest/model-config`、`useQuery` from `@tanstack/react-query`

**逻辑说明：**

```
profile.isPending  → SplashScreen
!resolved          → SplashScreen（等待异步路由决策）
已认证 + 非登录前路由 + modelsPending → SplashScreen
已认证 + 非登录前路由 + models 为空列表 → ModelSetupOverlay
其他               → 渲染 children
```

pre-login 路由：`/login`、`/setup`（`/setup` 是注册+org+model 向导，自己管自己）

- [ ] **Step 1: 修改 `auth-guard.tsx`**

在现有 imports 后追加：

```tsx
import { useQuery } from "@tanstack/react-query";
import { ModelSetupOverlay } from "@/components/model-setup-overlay";
import { fetchModelConfigs } from "@/rest/model-config";
```

在 `AuthGuard` 组件内，`const profile = ...` 和 `const [resolved, setResolved] = useState(false)` 之后，紧接着添加：

```tsx
const isAuthenticated = profile.isSuccess && profile.data != null;
const isPreLoginRoute = pathname === "/login" || pathname === "/setup";

const { data: modelConfigs, isPending: modelsPending } = useQuery({
  queryKey: ["model-configs"],
  queryFn: fetchModelConfigs,
  // 仅在已认证且不在登录前路由时才拉取，避免未认证状态发出无效请求
  enabled: isAuthenticated && !isPreLoginRoute,
  staleTime: 60_000,
});
```

将文件末尾的渲染部分（现为两行）：

```tsx
if (profile.isPending || !resolved) {
  return <SplashScreen />;
}

return <>{children}</>;
```

替换为：

```tsx
if (profile.isPending || !resolved) {
  return <SplashScreen />;
}

// 已认证 + 非登录前路由：追加模型配置守卫
if (isAuthenticated && !isPreLoginRoute) {
  if (modelsPending) return <SplashScreen />;
  // 成功拉到空列表 → 引导配置；拉取失败（网络异常等）不阻塞用户
  if (modelConfigs?.length === 0) return <ModelSetupOverlay />;
}

return <>{children}</>;
```

- [ ] **Step 2: 运行类型检查和格式化**

```bash
cd /Users/grant/Meta1/meshbot
pnpm typecheck 2>&1 | head -50
pnpm format
```

预期：无 TS 错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/components/auth-guard.tsx
git commit -m "feat(web-agent): AuthGuard 追加模型配置布局级守卫，无模型时显示全屏引导"
```

---

### Task 4: 简化 login 页跳转逻辑

**Files:**
- Modify: `apps/web-agent/src/app/login/page.tsx`

**说明：** 登录成功后，只在 `needs-org` 时跳 `/setup`（org 配置必须走向导流程），其余情况（`needs-model`、`ready`）统一跳 `/assistant`。AuthGuard 的模型配置守卫会自动拦截 `needs-model` 场景并展示 `ModelSetupOverlay`。

- [ ] **Step 1: 修改 `login/page.tsx` 中的 `onSubmit`**

找到当前的：

```tsx
try {
  const status = await fetchAuthStatus();
  router.replace(
    status.step === "needs-org" || status.step === "needs-model"
      ? "/setup"
      : "/assistant",
  );
} catch {
  router.replace("/assistant");
}
```

替换为：

```tsx
try {
  const status = await fetchAuthStatus();
  // needs-org 必须走 /setup 补完组织创建流程；
  // needs-model / ready 均进 /assistant，由 AuthGuard 布局层决定是否显示模型配置引导。
  router.replace(status.step === "needs-org" ? "/setup" : "/assistant");
} catch {
  router.replace("/assistant");
}
```

- [ ] **Step 2: 运行类型检查和格式化**

```bash
cd /Users/grant/Meta1/meshbot
pnpm typecheck 2>&1 | head -50
pnpm format
```

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/app/login/page.tsx
git commit -m "fix(web-agent): 登录后 needs-model 不再跳 /setup，由 AuthGuard 布局守卫接管"
```

---

## 手动验证清单

运行 `pnpm dev:server-agent` + `pnpm dev:web-agent`，逐一验证以下场景：

**场景 A：直接登录（有账号、有组织、无模型）**
1. 在 `/login` 输入已有账号凭据 → 点击登录
2. 预期：跳转到 `/assistant`，但页面显示 ModelSetupOverlay（AuthShellLayout 样式，左侧品牌区块）
3. 填写模型配置 → 点击保存
4. 预期：ModelSetupOverlay 消失，正常 `/assistant` 内容出现（无 redirect，原地切换）

**场景 B：完整注册流程（register → org → model）**
1. 访问 `/setup` → 注册新账号 → 创建组织 → 配置模型 → 跳转 `/assistant`
2. 预期：各步骤正常，最终进入主界面

**场景 C：已登录用户刷新页面**
1. 已配置模型的用户刷新任意页面（/assistant、/messages 等）
2. 预期：SplashScreen 短暂出现后，正常页面加载，不显示 ModelSetupOverlay

**场景 D：未登录用户直接访问 /assistant**
1. 清除 token，直接访问 `/assistant`
2. 预期：AuthGuard 检测到 401 → 跳 `/login`

**场景 E：已登录用户访问 /setup**
1. 已登录（有模型）用户手动访问 `/setup`
2. 预期：setup 页面正常渲染（不被 ModelSetupOverlay 拦截，因为 /setup 是 pre-login 路由）
