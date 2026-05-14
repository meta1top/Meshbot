---
name: web-form-convention
description: "前端表单规范（web-agent / web-main）— 共享 Zod Schema + Form/FormItem + useSchema 多语言 Use when files matching apps/web-agent/**/*, apps/web-main/**/* change, or when explicitly invoked."
---

# 前端表单规范

适用范围：`apps/web-agent`、`apps/web-main` 两个前端应用。

> **i18n 适用性**：本规则中涉及 i18n 的部分（第 2 步 `useSchema` 与第 4 步 `useTranslation`）对 `web-agent` 与 `web-main` 均**强制要求**。两个应用都已接入 next-intl 翻译 JSON，不可裸字符串。

---

## 标准写法

### 1. 校验 Schema 放在对应类型库

- **必须**把表单的 Zod Schema 放进所属业务域的类型包：
  | 应用 | 推荐 Schema 包 |
  |---|---|
  | web-agent | `@meshbot/types-agent`（`libs/types-agent`） |
  | web-main | `@meshbot/types-main`（`libs/types-main`） |
  | 跨域通用（如登录） | `@meshbot/types`（`libs/types`） |

- 为「页面表单」和「API 请求体」**分开命名**：前者描述用户输入（如明文密码、可选字段），后者描述网络载荷（如加密后的密文、强制字段）。
  例：`ApiKeyCreateFormSchema`（表单）vs `CreateApiKeyDtoSchema`（API）。

- 校验文案使用**可作为 i18n 键的中文短句**（如 `"请输入用户名"`），写在 `z.string().min(1, { message: "…" })` 等位置。`useSchema` 会对这些 `message` 做 `t(message)` 翻译。

```ts
// libs/types-agent/src/apikey/apikey.schema.ts
import { z } from "zod";

export const ApiKeyCreateFormSchema = z.object({
  name: z.string().min(1, { message: "请输入 Key 名称" }),
  description: z.string().optional(),
  expiresAt: z.string().optional(),
});

export type ApiKeyCreateFormData = z.infer<typeof ApiKeyCreateFormSchema>;
```

### 2. `useSchema` ——校验文案多语言（web-agent / web-main 均强制）

- 包路径：`@meshbot/design/hooks`
- 用法：

  ```ts
  import { useSchema } from "@meshbot/design/hooks";

  const translatedSchema = useSchema(ApiKeyCreateFormSchema);
  ```

- 必须把 `translatedSchema` 传给 `<Form schema={translatedSchema}>`，**禁止**直接把未经过 `useSchema` 的静态 Schema 喂给 `<Form>`，否则切换语言时校验文案不会跟着翻译。

### 3. `Form` / `FormItem` ——表单结构

- 包路径：`@meshbot/design/form`（子路径导入，按 Task A5 的约定）

  ```ts
  import { Form, FormItem } from "@meshbot/design/form";
  import { Input } from "@meshbot/design";
  ```

- 标准结构：

  ```tsx
  const form = Form.useForm<ApiKeyCreateFormData>();
  const translatedSchema = useSchema(ApiKeyCreateFormSchema);

  <Form
    form={form}
    schema={translatedSchema}
    defaultValues={{ name: "", description: "" }}
    onSubmit={handleSubmit}
  >
    <FormItem label="Key 名称" name="name">
      <Input placeholder="例如：prod-agent-key" />
    </FormItem>
  </Form>
  ```

- **每个 `<FormItem>` 必须只有一个子节点**：`FormItem` 内部通过 `cloneElement` 把 `react-hook-form` 的 `value` / `onChange` 注入到唯一子节点。如果需要"输入框 + 显隐按钮"等组合控件，**整块封装成一个自定义组件**（内部再放 `<Input>` + `<Button>`），并把 `field` / `ref` 透传到真正的输入元素上。

### 4. 页面文案与标签（web-agent / web-main 均强制 i18n）

- 页面可见字符串（标题、`label`、`placeholder`、按钮文字）使用 `useTranslation()` 的 `t("…")`，与 `useSchema` 共用同一套 i18n 资源（详见 `i18n-key-convention.mdc`）。

### 5. 提交与副作用

- `onSubmit` 接收已通过 Zod 校验的强类型数据。
- 需要加密 / 转换字段后再调 `rest` 时，在 `mutationFn` 或 `onSubmit` 里完成转换。**不要**把仅适用于后端的 API Schema 形状（如 `CreateApiKeyDtoSchema`）误用作表单 `defaultValues`。

```ts
const handleSubmit = async (data: ApiKeyCreateFormData) => {
  const res = await createApiKey({
    name: data.name,
    description: data.description || undefined,
    expiresAt: data.expiresAt || undefined,
  });
  if (res.data) onCreated(res.data.rawKey, res.data.key);
};
```

### 6. `createI18nZodDto` 后端 DTO

- 后端 DTO 类由 `@meshbot/common` 提供的 `createI18nZodDto` 生成，前后端复用同一份 Zod Schema：

  ```ts
  import { createI18nZodDto } from "@meshbot/common";
  import { ApiKeyCreateFormSchema } from "@meshbot/types-agent";

  export class CreateApiKeyDto extends createI18nZodDto(ApiKeyCreateFormSchema) {}
  ```

---

## 反模式（代码评审会被打回）

- ❌ 手写 `<form onSubmit>` + 多个 `useState` 管理字段 + 手动校验、手动错误展示，不使用 `Form` / `FormItem` / Zod
- ❌ 在页面文件里手写一份和 `libs/types-*` 不一致的 Zod 对象作为唯一来源——Schema 必须放在共享类型库，让前后端复用同一份
- ❌ `<FormItem>` 下放多个兄弟节点（如 `<Input>` 与 `<button>` 并列），导致 `control` 注入失败
- ❌ 跳过 `useSchema` 直接把静态 Schema 传给 `<Form>`——切换语言时校验文案不会翻译
- ❌ 使用已废弃的 `@antalpha/design` / `@antalpha/common`（这两个包名已不存在）

---

## 参考实现

- **API Key 创建对话框**：`apps/web-agent/src/app/(main)/api-keys/page.tsx`
  - `ApiKeyCreateFormSchema`（来自 `@meshbot/types-agent`）+ `Form` + `useSchema` 完整组合
  - `Dialog` 的"创建"按钮放在 `Form` 外侧的 `footer`，通过 `form.submit?.()` 触发表单提交
  - 通过递增 `key` 强制每次打开 `<Form>` 重挂载，确保"每次打开都是空表"

### `Form.useForm()` 的注意事项

- `Form.useForm()` 返回的实例在子组件 `<Form>` 挂载并通过 `_setForm` 合并 `react-hook-form` 之前，**没有**完整的 `reset` / `handleSubmit` 等方法
- 在对话框未打开或子树未挂载时调用 `form.reset()` 会报错，应使用可选链 **`form.reset?.()`**
- 需要"每次打开都是空表"时，对 `<Form>` 使用递增 **`key`** 强制重挂载（见 `api-keys/page.tsx`）

