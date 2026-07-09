# web-main 加模型表单 provider 预设联动 设计 spec

**日期:** 2026-07-09
**分支:** 当前 worktree 分支 `worktree-feat+web-main-onboarding-gate`（在 `ModelFormPanel` 抽出后的同一条线上继续，尚未合并 main）

## 背景与问题

web-main 的加模型表单（`ModelFormPanel`，被 `settings/models` 页与 `OnboardingGate` owner 模型步复用）当前把每个字段都当成手填项：`name` 必填、`model` 是纯文本输入、`baseUrl` 只有静态占位符不预填。用户配 DeepSeek 之类的供应商要手敲名称、模型名、endpoint，体验繁琐。

对照 web-agent 旧版（已随「模型编辑收敛云端」下线，见 `77d2d6f^:apps/web-agent/src/components/setup/model-form.tsx`）：它是 **provider 预设驱动**——先选供应商，表单即自动带出该供应商的模型下拉、`default_base_url`，`name` 选填自动生成，于是**只需填 apiKey**。

关键事实:web-main 的 `ModelFormPanel` **已经 import 了同一份 `PROVIDERS`**（`libs/types-agent/src/ai/providers.ts`），每个供应商自带 `models[]` / `default_base_url` / `description`，但当前只用了 `type`/`name` 做下拉，其余预设被浪费。因此恢复便捷体验**纯前端即可，零后端改动、不新增依赖**。

## 目标

- 选中供应商即预填 `baseUrl`、`model`，`name` 选填 → 配 DeepSeek「只填 apiKey」。
- 改动收敛在共享的 `ModelFormPanel`，`settings/models` 与 `OnboardingGate` 两处同时受益。
- 保持 web-main 现有 `Form/FormItem` + `useSchema` 表单约定（不退回裸 `useForm`），保持所有字段可见（选填项标注 + 预填，不折叠）。

## 非目标（YAGNI）

- **不**引入供应商图标（simple-icons）与描述行；纯锦上添花，后续可单独加。
- **不**改后端 / `OrgModelConfigCreateInput` / provider 元数据来源（继续用静态 `PROVIDERS`，不引入 `useProviders` 后端拉取）。
- **不**折叠「高级选项」；选填字段保持可见并标注。
- **不**动 `OnboardingGate` 的分步决策、列表 / 编辑 / 删除 / owner 判定等既有逻辑。

## 数据源

`PROVIDERS: readonly ProviderDef[]`（`@meshbot/types-agent`，web-main 经 `@meshbot/web-common` 或直接引用）：

| type | name | default_base_url | models |
|------|------|------------------|--------|
| openai | OpenAI | https://api.openai.com/v1 | gpt-4o, gpt-4.1, ... |
| anthropic | Anthropic | https://api.anthropic.com | claude-opus-4-7, ... |
| google | Google Generative AI | https://generativelanguage.googleapis.com/v1beta | gemini-2.5-pro, ... |
| deepseek | DeepSeek | https://api.deepseek.com | deepseek-v4-pro, deepseek-chat |
| ollama | Ollama | http://localhost:11434 | [] |
| openai-compatible | OpenAI 兼容接口 | "" | [] |

`models` 为空的供应商（ollama、openai-compatible）→ 模型字段回退为手填。

## 架构与组件边界

**唯一改动文件:** `apps/web-main/src/components/models/model-form-panel.tsx`（+ i18n key）。

结构调整（都在该文件内）:

1. **`ModelFormFields`（新内部组件，作为 `<Form>` 的子节点）**
   `<Form>` 底层是 react-hook-form 的 `FormProvider`，故其子组件可用 `useFormContext()` 取 `watch` / `setValue` / `getValues`。把现有字段体移入此组件，承载 provider→预填 的联动副作用。
   - 依赖:`useFormContext()`、`PROVIDERS`。
   - 职责:监听 `providerType`，在用户**主动切换**供应商时 `setValue("baseUrl", preset.default_base_url)`、`setValue("model", preset.models[0] ?? "")`；并把「当前供应商是否有预设模型 / 有哪些模型」下传给 model 字段控件。

2. **`ModelField`（新内部受控组件，塞进 `<FormItem name="model">` 作单子节点）**
   接收 `FormItem` 注入的 `field`（`value`/`onChange`）+ 一个 `models: string[]` prop。
   - `models.length > 0` 且未切「自定义」→ 渲染模型下拉（`Select`，桥接 `onChange`→`onValueChange`，仿现有 `ProviderSelect`）+ 一个「自定义」入口切到手填。
   - `models.length === 0` 或已切「自定义」→ 渲染 `Input` 手填。
   - 内部 `customModel` 布尔状态；供应商切换时由父组件通过 `key` 或受控重置回下拉态。

3. **纯函数（新，便于单测，零 React 依赖）**
   - `resolveProviderPreset(providerType): ProviderDef | undefined` — 从 `PROVIDERS` 查预设（找不到返回 undefined，交由调用方兜底）。
   - `deriveModelName(values): string` — `name` 留空时生成 `${供应商名} - ${model}`（供应商名取 preset.name，缺失回退 providerType）。
   放在同文件或就近的 `model-form-panel.helpers.ts`（实现时定），由 `modelFormValuesToCreateInput` 与 `ModelFormFields` 调用。

## 交互与数据流

**create 模式:**
- `defaultValues.providerType = PROVIDERS[0].type`（OpenAI），且 `model`/`baseUrl` 初始化为 OpenAI 预设的 `models[0]` / `default_base_url`（进来即可用态）。
- 用户切供应商 → `ModelFormFields` 副作用重置 `model`/`baseUrl` 为新预设。
- 提交:`modelFormValuesToCreateInput` 中，`name` 空 → `deriveModelName` 兜底。

**edit 模式:**
- 初始值来自已存配置（`initial.providerType`/`model`/`baseUrl`）。
- **首次挂载不得被预设覆盖**:用 `useRef` 记录上一个 `providerType`，副作用跳过首次运行（ref 初始 = 初始 providerType），仅当用户**主动切换**供应商时才重置 `model`/`baseUrl`。
- `apiKey` 编辑态仍选填（留空 = 不换，沿用现有 `buildFormSchema(requireApiKey)` 语义）。

**schema 变更:**
- `buildFormSchema`:`name` 由必填改为选填（`.optional()`，仍保留 max 长度校验）。其余字段不变。
- `model` 校验不变（非空必填,由下拉默认值或手填满足）。

## 边界与错误处理

- 供应商无预设模型（ollama / openai-compatible）→ model 手填，不因 `models[0]` 为 undefined 报错（`?? ""`）。
- openai-compatible 的 `default_base_url` 为空串 → baseUrl 预填为空，用户自行填（符合「任意兼容接口」语义）。
- 供应商 type 不在 `PROVIDERS` 中（理论不会，下拉受限）→ `resolveProviderPreset` 返回 undefined，联动跳过、字段保持当前值。
- 所有用户可见文案走 next-intl，新增 key（「自定义」入口、name 选填标注等）en/zh 双语同步。

## 测试

- **纯函数单测（根 jest，相对 import，勿用 `@/`）:** `deriveModelName`（空 name 生成、供应商名缺失回退）、`resolveProviderPreset`（命中 / 未命中）。新建 `apps/web-main/src/components/models/model-form-panel.helpers.spec.ts`（或与 helpers 同名 spec）。
- **端到端眼验（起 web-main + server-main）:**
  1. `settings/models` 新建:选 DeepSeek → baseUrl 自动填 `https://api.deepseek.com`、模型下拉选中 `deepseek-v4-pro`、name 留空 → 只填 apiKey 可提交成功；生成的 name 为 `DeepSeek - deepseek-v4-pro`。
  2. 切「自定义」→ model 变手填,输入任意模型名可提交。
  3. 选 ollama / openai-compatible → model 直接手填。
  4. **编辑态不误清**:编辑已存配置,首屏保留原 model/baseUrl;主动切供应商才重置。
  5. `OnboardingGate` owner 模型步同样表现（同一 `ModelFormPanel`）。

## 影响面

- 改动文件:`apps/web-main/src/components/models/model-form-panel.tsx`、其 helpers 与 spec、`apps/web-main/messages/{en,zh}.json`。
- 不改:后端、`OrgModelConfigCreateInput`、`PROVIDERS` 数据、`settings/models` 页的列表/编辑/删除逻辑、`OnboardingGate` 决策逻辑。
