# 前端交互

## 技术栈

### 核心框架
- **Next.js** (App Router) - React 全栈框架
- **TypeScript** - 类型安全
- **React** - UI 库

### 状态管理
- **Jotai** - 原子化状态管理库，用于客户端状态
- **@tanstack/react-query** - 服务端状态管理，数据获取和缓存

### UI 组件库
- **@meta-1/design** - 自定义组件库（主要 UI 组件）
- **@meta-1/editor** - 自定义编辑器组件库

### 样式方案
- **Tailwind CSS v4** - 原子化 CSS 框架（使用新的 @theme 语法）

### 表单处理
- **react-hook-form** - 表单状态管理和验证

### 国际化
- **i18next** - 国际化框架
- **react-i18next** - React i18next 集成

### 主题管理
- **next-themes** - Next.js 主题切换（支持暗色模式）

### 工具库
- **es-toolkit** - 工具函数库

## 组件库

`@meta-1/design` 是我们基于 `shadcn/ui` 提供了一些高阶组件。

- `@meta-1/design` 是通过源码发布的，你可以查看 `node_modules/@meta-1/design/**` 获取你需要的组件的实现逻辑。
- 如果 `@meta-1/design` 存在 `shadcn/ui` 新增的组件，你可以提醒用户。

## 项目结构

- `src/app/` - Next.js App Router 页面和路由
- `src/components/` - 可复用组件
- `src/hooks/` - 自定义 Hooks
- `src/state/` - Jotai 状态定义
- `src/rest/` - API 请求封装
- `src/utils/` - 工具函数
- `src/config/` - 配置文件
- `src/types/` - TypeScript 类型定义
