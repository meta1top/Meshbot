# web-main 加模型表单 provider 预设联动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 web-main 加模型表单像旧 web-agent 一样便捷——选中供应商即自动预填 `baseUrl` 与 `model`（已知模型下拉 + 自定义入口）、`name` 选填自动生成，配 DeepSeek 之类只需填 apiKey。

**Architecture:** 纯前端接入已有 `PROVIDERS` 预设（`@meshbot/types-agent`，含 `models[]` / `default_base_url`）。可测的纯逻辑（供应商预设查找、name 自动生成）抽到零 React 的 `.ts` helper 并单测；UI 联动全部收敛在共享的 `ModelFormPanel`（同时被 `settings/models` 与 `OnboardingGate` owner 步复用），用 `useFormContext` 在切换供应商时同步重置 model/baseUrl。零后端改动、不新增依赖。

**Tech Stack:** Next 16 (App Router) + React 19 + react-hook-form ^7（`useFormContext`）+ `@meshbot/design`（`Form`/`FormItem`/`useSchema`/`Select`/`Input`/`Button`）+ next-intl + `@meshbot/types-agent`（`PROVIDERS`）+ 根 jest（ts-jest）。

## Global Constraints

- 只改 web-main 前端;**零后端改动**、不改 `OrgModelConfigCreateInput`、不新增依赖（不引 simple-icons，本期无供应商图标）。
- 保持 `Form`/`FormItem` + `useSchema` 表单约定，**不退回裸 `useForm`**（`web-form-convention` 技能）。
- 所有用户可见文案走 next-intl,新增 key **en/zh 双语同步**（pre-commit 的 `sync-locales.ts --check` 校验，须 `missing=0, asymmetric=0`）。
- 纯逻辑单测走**根 jest**,spec 与被测模块都是 `.ts`（jest `transform` 只匹配 `^.+\.ts$`,`.tsx` 不被转换),**相对 import**,勿用 `@/`（根 jest 的 `@/` alias 指向 web-agent）。
- 纯 helper 及其 spec 从**真源 `@meshbot/types-agent`** 引 `PROVIDERS`/`ProviderDef`,**勿从 `@meshbot/web-common` 引**（web-common 入口传递引入 axios/theme 等前端面,会拖垮 node 环境的 jest,参考被 ignore 的 `use-global-events.spec.ts`）。
- 提交中文 conventional commits,结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 所有命令在 worktree 根 `/Users/grant/Meta1/meshbot/.claude/worktrees/feat+web-main-onboarding-gate` 下执行,分支 `worktree-feat+web-main-onboarding-gate`。

## 文件结构

- **Create** `apps/web-main/src/components/models/model-form-panel.helpers.ts` — 纯逻辑:`resolveProviderPreset`（按 type 查预设）+ `deriveModelName`（name 空则「供应商名 - 模型」）。零 React 依赖,从 `@meshbot/types-agent` 引 `PROVIDERS`/`ProviderDef`。
- **Create** `apps/web-main/src/components/models/model-form-panel.helpers.spec.ts` — 上述两函数的根 jest 单测（相对 import）。
- **Modify** `apps/web-main/src/components/models/model-form-panel.tsx` — schema `name` 改选填、`modelFormValuesToCreateInput` 用 `deriveModelName`、`ProviderSelect` 切换联动重置、新增 `ModelField`（下拉/手填）与 `ModelFormFields`（`useFormContext` 联动）内部组件、create 初值按 `PROVIDERS[0]` 预填。
- **Modify** `apps/web-main/src/app/(shell)/settings/models/page.tsx` — 编辑分支 `name` 也走 `deriveModelName`（name 选填后保持一致,避免清空 name 提交空名）。
- **Modify** `apps/web-main/messages/en.json` + `apps/web-main/messages/zh.json` — `models` 命名空间新增 4 个 key。

`OnboardingGate`（`components/auth/onboarding-gate.tsx`）**不改**:它只走 create、复用 `modelFormValuesToCreateInput`,自动获得 name 生成与联动收益。

---

### Task 1: 纯逻辑 helper `resolveProviderPreset` + `deriveModelName` + 单测

**Files:**
- Create: `apps/web-main/src/components/models/model-form-panel.helpers.ts`
- Test: `apps/web-main/src/components/models/model-form-panel.helpers.spec.ts`

**Interfaces:**
- Produces:
  - `resolveProviderPreset(providerType: string): ProviderDef | undefined` — 从 `PROVIDERS` 按 `type` 查预设,未命中返回 `undefined`。
  - `deriveModelName(input: { name?: string; providerType: string; model: string }): string` — `name` 去空格后非空则原样返回;空则返回 `${供应商名} - ${model}`,供应商未命中预设时用 `providerType` 作标签。
  - 二者供 Task 2 的 `model-form-panel.tsx` 与 `settings/models/page.tsx` 消费。

- [ ] **Step 1: 先写失败单测 `model-form-panel.helpers.spec.ts`**（相对 import,勿用 `@/`）

```ts
import {
  deriveModelName,
  resolveProviderPreset,
} from "./model-form-panel.helpers";

describe("resolveProviderPreset", () => {
  it("命中已知供应商 → 返回预设（带 models / default_base_url）", () => {
    const preset = resolveProviderPreset("deepseek");
    expect(preset?.name).toBe("DeepSeek");
    expect(preset?.default_base_url).toBe("https://api.deepseek.com");
    expect(preset?.models.length).toBeGreaterThan(0);
  });

  it("未知供应商 → undefined", () => {
    expect(resolveProviderPreset("nope")).toBeUndefined();
  });
});

describe("deriveModelName", () => {
  it("name 非空 → 去空格原样返回", () => {
    expect(
      deriveModelName({
        name: "  My GPT ",
        providerType: "openai",
        model: "gpt-4o",
      }),
    ).toBe("My GPT");
  });

  it("name 空串 → 「供应商名 - 模型」", () => {
    expect(
      deriveModelName({
        name: "",
        providerType: "deepseek",
        model: "deepseek-v4-pro",
      }),
    ).toBe("DeepSeek - deepseek-v4-pro");
  });

  it("name 未提供 + 未知供应商 → providerType 作标签回退", () => {
    expect(deriveModelName({ providerType: "acme", model: "x" })).toBe(
      "acme - x",
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec jest apps/web-main/src/components/models/model-form-panel.helpers.spec.ts`
Expected: FAIL — `Cannot find module './model-form-panel.helpers'`。

- [ ] **Step 3: 实现 `model-form-panel.helpers.ts`**

```ts
import { PROVIDERS, type ProviderDef } from "@meshbot/types-agent";

/** 从 PROVIDERS 预设清单按 type 查供应商定义;未命中返回 undefined。 */
export function resolveProviderPreset(
  providerType: string,
): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.type === providerType);
}

/**
 * 计算模型配置名:name 去空格后非空则原样返回;
 * 空则按「供应商名 - 模型」自动生成,供应商未命中预设时用 providerType 作标签。
 */
export function deriveModelName(input: {
  name?: string;
  providerType: string;
  model: string;
}): string {
  const trimmed = input.name?.trim();
  if (trimmed) {
    return trimmed;
  }
  const label =
    resolveProviderPreset(input.providerType)?.name ?? input.providerType;
  return `${label} - ${input.model}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec jest apps/web-main/src/components/models/model-form-panel.helpers.spec.ts`
Expected: PASS（3 个 describe 全绿）。

- [ ] **Step 5: 提交**

```bash
git add apps/web-main/src/components/models/model-form-panel.helpers.ts \
        apps/web-main/src/components/models/model-form-panel.helpers.spec.ts
git commit -m "feat(web-main): 加模型表单预设逻辑 resolveProviderPreset + deriveModelName + 单测

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `ModelFormPanel` 联动 UI + schema + i18n + 编辑分支一致性

**Files:**
- Modify: `apps/web-main/src/components/models/model-form-panel.tsx`（整文件替换,见 Step 3）
- Modify: `apps/web-main/src/app/(shell)/settings/models/page.tsx`（编辑分支 name）
- Modify: `apps/web-main/messages/en.json` + `apps/web-main/messages/zh.json`（4 个 key）

**Interfaces:**
- Consumes: Task 1 的 `resolveProviderPreset` / `deriveModelName`。
- Produces（对外导出不变,消费方 `page.tsx` / `onboarding-gate.tsx` 无需改导入）:
  - `ModelFormPanel`（React 组件,props 不变）
  - `buildFormSchema(requireApiKey: boolean)`（`name` 改为选填）
  - `type ModelFormValues`
  - `modelFormValuesToCreateInput(values: ModelFormValues): OrgModelConfigCreateInput`（`name` 内部走 `deriveModelName`）

- [ ] **Step 1: 新增 4 个 i18n key（en.json + zh.json,`models` 命名空间）**

在 `apps/web-main/messages/en.json` 的 `"models"` 对象内加:

```json
    "fieldNameOptional": "Name (optional)",
    "fieldNameHint": "Leave blank to auto-generate from provider and model",
    "fieldModelSelectPlaceholder": "Select a model",
    "fieldModelCustom": "Custom",
```

在 `apps/web-main/messages/zh.json` 的 `"models"` 对象内加:

```json
    "fieldNameOptional": "名称（可选）",
    "fieldNameHint": "留空将按供应商与模型自动生成",
    "fieldModelSelectPlaceholder": "请选择模型",
    "fieldModelCustom": "自定义",
```

（放在各自 `"fieldName"` / `"fieldModel"` 附近即可,JSON key 无顺序要求;保留原有 `fieldName` key,`ModelFormPanel` 改用 `fieldNameOptional` 作 label。）

- [ ] **Step 2: 校验 i18n 对齐**

Run: `pnpm exec tsx scripts/sync-locales.ts -- --check`
Expected: 输出末尾 `Done (missing=0, asymmetric=0)`（新增 key 此刻尚未被引用,会出现在 ORPHAN 列表——正常,Step 3 引用后消失,不影响 `missing`/`asymmetric`）。

- [ ] **Step 3: 整文件替换 `apps/web-main/src/components/models/model-form-panel.tsx`**

```tsx
"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@meshbot/design";
import { Form, FormItem } from "@meshbot/design/form";
import { useSchema } from "@meshbot/design/hooks";
import type { OrgModelConfigView } from "@meshbot/types";
import type { OrgModelConfigCreateInput } from "@meshbot/types-main";
import { PROVIDERS } from "@meshbot/web-common";
import { useTranslations } from "next-intl";
import { forwardRef, useState } from "react";
import { useFormContext } from "react-hook-form";
import { z } from "zod";
import {
  deriveModelName,
  resolveProviderPreset,
} from "./model-form-panel.helpers";

/**
 * provider 下拉——Radix `Select` 用 `value`/`onValueChange`（非原生 `onChange`）,
 * 不能直接当 `FormItem` 单子节点被 cloneElement 注入 react-hook-form field,
 * 用受控包装把 `onChange` 桥接到 `onValueChange`。
 *
 * 切换供应商时顺带把 `model` / `baseUrl` 重置为新供应商预设（下拉首项 /
 * default_base_url）——经 `useFormContext` 拿 `setValue`。仅用户交互触发,
 * 不影响首屏（create 初值 / edit 已存值）。
 */
const ProviderSelect = forwardRef<
  HTMLButtonElement,
  { value?: string; onChange?: (value: string) => void; placeholder: string }
>(({ value, onChange, placeholder }, ref) => {
  const { setValue } = useFormContext<ModelFormValues>();
  const handleChange = (next: string) => {
    onChange?.(next);
    const preset = resolveProviderPreset(next);
    setValue("model", preset?.models[0] ?? "", { shouldValidate: true });
    setValue("baseUrl", preset?.default_base_url ?? "");
  };
  return (
    <Select value={value} onValueChange={handleChange}>
      <SelectTrigger ref={ref}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {PROVIDERS.map((p) => (
          <SelectItem key={p.type} value={p.type}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});
ProviderSelect.displayName = "ProviderSelect";

/**
 * 模型字段——供应商有预设模型时渲染下拉（+「自定义」入口切手填）;
 * 无预设模型（ollama / openai-compatible）或初值不在预设列表 / 已切自定义时手填。
 * 由 `FormItem` 注入 `value`/`onChange`。父组件用 `key={providerType}` 在切换
 * 供应商时重挂本组件,重置自定义态（此时 model 已被 ProviderSelect 同步重置为首项）。
 */
const ModelField = forwardRef<
  HTMLButtonElement,
  {
    value?: string;
    onChange?: (value: string) => void;
    models: readonly string[];
    selectPlaceholder: string;
    inputPlaceholder: string;
    customLabel: string;
  }
>(
  (
    {
      value,
      onChange,
      models,
      selectPlaceholder,
      inputPlaceholder,
      customLabel,
    },
    ref,
  ) => {
    // 初值不在预设列表（自定义 / 冷门模型）→ 直接手填,避免下拉选不中
    const [custom, setCustom] = useState(
      () => !!value && !models.includes(value),
    );
    if (models.length === 0 || custom) {
      return (
        <Input
          value={value ?? ""}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={inputPlaceholder}
        />
      );
    }
    return (
      <div className="flex gap-2">
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger ref={ref} className="flex-1">
            <SelectValue placeholder={selectPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="link"
          className="whitespace-nowrap"
          onClick={() => setCustom(true)}
        >
          {customLabel}
        </Button>
      </div>
    );
  },
);
ModelField.displayName = "ModelField";

/**
 * 表单层 Schema（区别于 API 请求体 `OrgModelConfigCreateInput`）:
 * `name` 选填（留空提交时由 `deriveModelName` 生成）;`contextWindow` 表单收字符串,
 * 提交转数字;`apiKey` 编辑态可选（留空 = 不换）,新建态必填。
 */
export function buildFormSchema(requireApiKey: boolean) {
  return z.object({
    name: z
      .string()
      .max(64, { message: "validation.stringTooLong" })
      .optional(),
    providerType: z.string().min(1, { message: "validation.required" }),
    model: z
      .string()
      .min(1, { message: "validation.required" })
      .max(128, { message: "validation.stringTooLong" }),
    apiKey: requireApiKey
      ? z
          .string()
          .min(1, { message: "validation.required" })
          .max(512, { message: "validation.stringTooLong" })
      : z.string().max(512, { message: "validation.stringTooLong" }).optional(),
    baseUrl: z
      .string()
      .max(255, { message: "validation.stringTooLong" })
      .optional(),
    contextWindow: z
      .string()
      .optional()
      .refine((v) => !v || (/^\d+$/.test(v) && Number(v) > 0), {
        message: "models.contextWindowPositive",
      }),
  });
}
export type ModelFormValues = z.infer<ReturnType<typeof buildFormSchema>>;

/**
 * 表单值 → 创建入参:`name` 空则按供应商+模型自动生成;`contextWindow` 空串转
 * `undefined`、非空转数字;`baseUrl` 空串转 `undefined`;`apiKey` 兜底空串。
 */
export function modelFormValuesToCreateInput(
  values: ModelFormValues,
): OrgModelConfigCreateInput {
  return {
    name: deriveModelName({
      name: values.name,
      providerType: values.providerType,
      model: values.model,
    }),
    providerType: values.providerType,
    model: values.model,
    apiKey: values.apiKey ?? "",
    baseUrl: values.baseUrl || undefined,
    contextWindow: values.contextWindow
      ? Number(values.contextWindow)
      : undefined,
  };
}

export interface ModelFormPanelProps {
  mode: "create" | "edit";
  initial: OrgModelConfigView | null;
  onCancel: () => void;
  onSubmit: (values: ModelFormValues) => Promise<void>;
  submitting: boolean;
  error: string | null;
}

/**
 * 表单字段体——拆成 `<Form>` 子组件,用 `useFormContext` 读 `providerType`
 * 联动 model 字段（下拉/手填 + key 重挂）。
 */
function ModelFormFields({
  mode,
  initial,
}: {
  mode: "create" | "edit";
  initial: OrgModelConfigView | null;
}) {
  const t = useTranslations("models");
  const { watch } = useFormContext<ModelFormValues>();
  const providerType = watch("providerType");
  const models = resolveProviderPreset(providerType)?.models ?? [];

  return (
    <>
      <FormItem
        name="name"
        label={t("fieldNameOptional")}
        description={t("fieldNameHint")}
      >
        <Input placeholder={t("fieldNamePlaceholder")} />
      </FormItem>
      <FormItem name="providerType" label={t("fieldProvider")}>
        <ProviderSelect placeholder={t("fieldProviderPlaceholder")} />
      </FormItem>
      <FormItem name="model" label={t("fieldModel")}>
        <ModelField
          key={providerType}
          models={models}
          selectPlaceholder={t("fieldModelSelectPlaceholder")}
          inputPlaceholder={t("fieldModelPlaceholder")}
          customLabel={t("fieldModelCustom")}
        />
      </FormItem>
      <FormItem
        name="apiKey"
        label={t("fieldApiKey")}
        description={
          mode === "edit"
            ? t("fieldApiKeyEditHint", { masked: initial?.apiKeyMasked ?? "" })
            : undefined
        }
      >
        <Input
          type="password"
          placeholder={
            mode === "edit" ? (initial?.apiKeyMasked ?? "") : "sk-..."
          }
        />
      </FormItem>
      <FormItem name="baseUrl" label={t("fieldBaseUrl")}>
        <Input placeholder={t("fieldBaseUrlPlaceholder")} />
      </FormItem>
      <FormItem name="contextWindow" label={t("fieldContextWindow")}>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          placeholder={t("fieldContextWindowPlaceholder")}
        />
      </FormItem>
    </>
  );
}

/** 新建 / 编辑配置面板（内嵌 Card,非 Dialog——项目当前无 Dialog 组件）。 */
export function ModelFormPanel({
  mode,
  initial,
  onCancel,
  onSubmit,
  submitting,
  error,
}: ModelFormPanelProps) {
  const t = useTranslations("models");
  const schema = useSchema(buildFormSchema(mode === "create"));
  // create 模式默认选中 PROVIDERS[0],model/baseUrl 一并按其预设预填,进来即可用态
  const createPreset = resolveProviderPreset(PROVIDERS[0]?.type ?? "");

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {mode === "create" ? t("createTitle") : t("editTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Form
          schema={schema}
          defaultValues={{
            name: initial?.name ?? "",
            providerType: initial?.providerType ?? PROVIDERS[0]?.type ?? "",
            model: initial?.model ?? createPreset?.models[0] ?? "",
            apiKey: "",
            baseUrl: initial?.baseUrl ?? createPreset?.default_base_url ?? "",
            contextWindow: initial?.contextWindow
              ? String(initial.contextWindow)
              : "",
          }}
          onSubmit={onSubmit}
          className="flex flex-col gap-4"
        >
          <ModelFormFields mode={mode} initial={initial} />

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? t("saving") : t("save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={submitting}
            >
              {t("cancel")}
            </Button>
          </div>
        </Form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: 改 `settings/models/page.tsx` 编辑分支 name 一致性**

在文件顶部 import 区加（与现有 `@/components/models/model-form-panel` import 并列）:

```ts
import { deriveModelName } from "@/components/models/model-form-panel.helpers";
```

把 `handleSubmit` 里 update 分支的 `name: values.name,`（约 79 行）改为:

```ts
            name: deriveModelName({
              name: values.name,
              providerType: values.providerType,
              model: values.model,
            }),
```

（create 分支已走 `modelFormValuesToCreateInput`,内部已含 `deriveModelName`,不动。）

- [ ] **Step 5: typecheck**

Run: `pnpm --filter @meshbot/web-main typecheck`
Expected: 无 TS 报错退出 0。
（若 filter 因 cwd 异常,回退 `pnpm typecheck` 跑全量。）

- [ ] **Step 6: i18n 对齐 + helper 单测复跑**

Run: `pnpm exec tsx scripts/sync-locales.ts -- --check`
Expected: `Done (missing=0, asymmetric=0)`,且 4 个新 key 不再在 web-main 的 ORPHAN 列表（已被 `t()` 引用）。

Run: `pnpm exec jest apps/web-main/src/components/models/model-form-panel.helpers.spec.ts`
Expected: PASS（Task 1 单测仍绿）。

- [ ] **Step 7: 提交**

```bash
git add apps/web-main/src/components/models/model-form-panel.tsx \
        apps/web-main/src/app/'(shell)'/settings/models/page.tsx \
        apps/web-main/messages/en.json \
        apps/web-main/messages/zh.json
git commit -m "feat(web-main): 加模型表单 provider 预设联动（选供应商即预填 baseUrl/model，name 选填自动生成）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: 端到端眼验（起 web-main + server-main 后端）**

前置:确保主检出没有占用 3002 / 3200（占用则先停,或本 worktree 改端口）。

Run:
```bash
pnpm dev:server-main   # 3200，需 Postgres/Redis 起着
pnpm dev:web-main      # 3002
```

登录进 owner 账号,逐项眼验（两处入口——`settings/models` 新建 与 `OnboardingGate` owner 模型步——应表现一致,因复用同一 `ModelFormPanel`）:

1. **DeepSeek 只填 apiKey**:`settings/models` → 新建 → 供应商选 DeepSeek → `baseUrl` 自动变 `https://api.deepseek.com`、模型下拉自动选中 `deepseek-v4-pro`、name 留空 → 只填 apiKey → 保存成功;列表里该行 name 显示 `DeepSeek - deepseek-v4-pro`。
2. **自定义模型**:新建 → 任一有预设的供应商 → 点模型旁「自定义」→ 变手填 → 输入任意模型名 → 可保存。
3. **无预设供应商**:新建 → 选 Ollama / OpenAI 兼容接口 → 模型直接是手填输入框（无下拉）。
4. **切换即重置**:新建 → 先选 OpenAI（model=gpt-4o）→ 再切 DeepSeek → model/baseUrl 应刷新为 DeepSeek 预设,不残留 OpenAI 的值。
5. **编辑态不误清**:编辑一条已存配置 → 首屏 model/baseUrl 保留原值不被预设覆盖;主动切供应商才重置;apiKey 留空保存 = 不换 key（列表 masked 不变）。

---

## 自检（对照 spec）

- **spec 覆盖:**
  - 「选供应商即预填 baseUrl/model」→ Task 2 `ProviderSelect.handleChange` + create 初值预填。✅
  - 「model 已知下拉 + 自定义入口 / 空预设手填」→ Task 2 `ModelField`。✅
  - 「name 选填 + 自动生成」→ Task 1 `deriveModelName` + Task 2 schema `.optional()` + `modelFormValuesToCreateInput` + page 编辑分支。✅
  - 「编辑态不误清、仅主动切换重置」→ `ProviderSelect` 仅 `onValueChange`（用户交互）触发 setValue;首屏与 create 初值分别由 defaultValues 提供。✅
  - 「create 初始态可用」→ Task 2 `createPreset` 预填 defaultValues。✅
  - 「保持 Form/FormItem 约定、零后端、不新增依赖、i18n 双语」→ Global Constraints + 各 Step。✅
  - 「纯函数单测（根 jest、相对 import）+ 端到端眼验」→ Task 1 spec + Task 2 Step 8。✅
- **placeholder 扫描:** 无 TBD/TODO;每个改码步骤含完整代码。✅
- **类型一致性:** `resolveProviderPreset` / `deriveModelName` 签名在 Task 1 定义、Task 2 按同签名调用;`ModelFormValues` / `modelFormValuesToCreateInput` / `buildFormSchema` 导出名与消费方（page.tsx / onboarding-gate.tsx）现有 import 名一致,未改对外接口。✅
- **spec 微调说明:** spec「非目标」曾写「不改 settings/models 页的编辑逻辑」;实际因 `name` 转选填,须同步把编辑分支 name 也走 `deriveModelName`（1 行,一致性收尾,非逻辑改动),已在 Task 2 Step 4 覆盖。
