# shadcn 组件库初始化与页面改造设计

> 日期：2026-05-04

## 背景

当前 `packages/design`（`@anybot/design`）是空壳包，已配好 `cva`/`clsx`/`tailwind-merge` 依赖但无组件。所有 UI 页面（login、setup、model-form）使用手写 Tailwind 类名，存在大量重复样式代码。

## 目标

1. 在 `packages/design` 中初始化 shadcn（New York 风格 + Tailwind v4）
2. 生成 7 个基础组件：Button、Input、Label、Card、Select、Alert、Form
3. 改造现有页面使用 shadcn 组件 + react-hook-form + zod 校验

## 架构

### 目录结构

```
packages/design/
  ├── components.json            ← shadcn CLI 配置
  ├── package.json               ← 更新依赖
  ├── tsconfig.json
  └── src/
      ├── index.ts               ← 统一导出所有组件
      ├── styles/
      │   └── globals.css        ← shadcn 主题 CSS 变量
      ├── lib/
      │   └── utils.ts           ← cn() 工具函数
      └── components/
          └── ui/                ← shadcn 生成的组件
              ├── button.tsx
              ├── input.tsx
              ├── label.tsx
              ├── card.tsx
              ├── select.tsx
              ├── alert.tsx
              └── form.tsx
```

### monorepo 配置策略

shadcn 在 monorepo 中需要两层 `components.json`：

**`packages/design/components.json`（UI 包）：**
- `style`: `"new-york"`
- `tailwind.config`: `""`（Tailwind v4 无配置文件）
- `tailwind.css`: `"src/styles/globals.css"`
- aliases 指向包内路径，使用 `@anybot/design` 作为前缀

**`apps/web-agent/components.json`（消费端）：**
- 相同的 style/baseColor/iconLibrary
- `tailwind.css` 指向 `../../packages/design/src/styles/globals.css`
- `ui` alias 指向 `@anybot/design/components`

这样通过 `npx shadcn@latest add <component>` 在 web-agent 目录下运行时，组件自动安装到 `packages/design`。

### CSS 主题

`packages/design/src/styles/globals.css` 包含：
- `@import "tailwindcss"` 
- `@import "tw-animate-css"`（shadcn 动画）
- `@theme inline { ... }`（Tailwind v4 主题映射）
- `:root { ... }`（CSS 变量：颜色、圆角等）

各 app 的 `globals.css` 改为 import design 包的样式：
```css
@import "@anybot/design/styles/globals.css";
```

### 消费方式

```tsx
import { Button } from "@anybot/design";
import { Input } from "@anybot/design";
import { Card, CardHeader, CardContent } from "@anybot/design";
```

包通过 `transpilePackages` 被 Next.js 直接消费源码（已配好），无需预编译。

## 组件清单

| 组件 | shadcn 名称 | 额外依赖 | 用途 |
|------|------------|---------|------|
| Button | button | — | 提交按钮、操作按钮 |
| Input | input | — | 文本/密码输入框 |
| Label | label | @radix-ui/react-label | 表单标签 |
| Card | card | — | 页面卡片容器 |
| Select | select | @radix-ui/react-select | 模型下拉选择 |
| Alert | alert | — | 错误/警告提示 |
| Form | form | react-hook-form, @hookform/resolvers | 表单容器 + 校验 |

## 页面改造

### 登录页 (`login/page.tsx`)

改造前：手写 `useState` 管理表单状态 + 手动提交
改造后：
- `useForm` + `zodResolver(loginSchema)` 管理表单
- `<Form>` + `<FormField>` + `<FormItem>` 结构
- `<Card>` 替换 `<div className="rounded-xl bg-white ...">`
- `<Input>` 替换手写 `<input>`
- `<Button>` 替换手写 `<button>`
- 校验错误通过 `<FormMessage>` 自动显示，去掉手动 error state

### Setup 页 (`setup/page.tsx`)

改造前：手写注册表单 + 手写模型配置
改造后：
- 注册步骤：`useForm` + `zodResolver(registerSchema)` + 增加 `confirmPassword` 校验
- 模型步骤：复用改造后的 `<ModelForm>`
- `<Card>` 包裹各步骤
- `<Alert>` 替换手写错误提示 div

### 模型配置表单 (`model-form.tsx`)

改造前：5 个 `useState` + 手动构造提交数据
改造后：
- `useForm` + `zodResolver(modelConfigSchema)` 
- `<FormField>` 包裹每个字段
- `<Select>` 替换原生 `<select>`（模型选择）
- `<Input>` 替换手写 input
- `<Button variant="link">` 替换"自定义"文本按钮

### Provider Card (`provider-card.tsx`)

改造前：手写 `<button>` + 条件类名
改造后：保持为业务组件，但内部使用 `cn()` 工具函数简化条件样式拼接

## 依赖变更

### packages/design 新增

- `@radix-ui/react-label`
- `@radix-ui/react-select`
- `react-hook-form`
- `@hookform/resolvers`
- `tw-animate-css`
- `lucide-react`
- `shadcn`（devDependency，CLI 工具）

### apps/web-agent 新增

- `react-hook-form`
- `@hookform/resolvers`

（作为 peerDependency 或直接安装，因为页面中直接使用 `useForm`）

## 不变的部分

- `packages/design` 继续以源码方式消费（`main: "./src/index.ts"`），不需要编译步骤
- `next.config.ts` 的 `transpilePackages` 已包含 `@anybot/design`
- `web-main` 暂不改造页面（它还没有业务页面），但 globals.css 也改为 import design 包样式，为后续做准备
