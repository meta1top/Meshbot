# 左侧菜单优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化 web-agent 左侧菜单的选中态/hover 态样式，移除多余按钮，提取可复用组件，支持基于路由的选中判断。

**Architecture:** 提取 `SidebarNavItem` 可复用组件统一处理选中态和 hover 态样式；在 `AppShellLayout` 中使用 `usePathname` 实现路由匹配；对话项使用 `group` 和 `opacity` 实现 hover 显示操作按钮。

**Tech Stack:** Next.js 15, React 19, Tailwind CSS v4, shadcn/ui, next-intl, lucide-react

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `apps/web-agent/src/components/common/sidebar-nav-item.tsx` | 创建 | 可复用导航项组件，统一处理 active/hover 样式 |
| `apps/web-agent/src/components/layouts/app-shell-layout.tsx` | 修改 | 接入 SidebarNavItem，移除"更多"和"个性化"，添加路由判断 |
| `apps/web-agent/messages/zh.json` | 修改 | 移除 `appShell.more`、`appShell.customize` |
| `apps/web-agent/messages/en.json` | 修改 | 移除 `appShell.more`、`appShell.customize` |

---

### Task 1: 创建 SidebarNavItem 组件

**Files:**
- Create: `apps/web-agent/src/components/common/sidebar-nav-item.tsx`

- [ ] **Step 1: 创建组件目录**

```bash
mkdir -p apps/web-agent/src/components/common
```

- [ ] **Step 2: 编写 SidebarNavItem 组件**

```tsx
"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

interface SidebarNavItemProps {
  icon: ReactNode;
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}

export function SidebarNavItem({
  icon,
  children,
  active,
  onClick,
  className,
}: SidebarNavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-2 rounded-none px-2 py-1.5 text-left text-[14px] transition-colors",
        active
          ? "bg-accent font-medium text-white"
          : "text-foreground/80 hover:bg-accent hover:text-white",
        className,
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center transition-colors",
          active
            ? "text-white"
            : "text-muted-foreground group-hover:text-white",
        )}
      >
        {icon}
      </span>
      {children}
    </button>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/components/common/sidebar-nav-item.tsx
git commit -m "feat(web-agent): add SidebarNavItem component

统一处理选中态和 hover 态样式：
- active 时 bg-accent + text-white + 图标白色
- hover 时 hover:bg-accent + hover:text-white + 图标白色
- 使用 group-hover 实现图标颜色联动"
```

---

### Task 2: 修改 AppShellLayout

**Files:**
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`

- [ ] **Step 1: 导入 usePathname 和 SidebarNavItem**

在现有 import 基础上添加：

```tsx
import { usePathname } from "next/navigation";
import { SidebarNavItem } from "@/components/common/sidebar-nav-item";
```

- [ ] **Step 2: 在组件内获取 pathname 并定义 active 判断**

在 `AppShellLayout` 函数体中，在 `const t = useTranslations("appShell");` 之后添加：

```tsx
const pathname = usePathname();

const isNewSessionActive = pathname === "/session/new";
const isScheduledActive = pathname === "/schedule";
```

- [ ] **Step 3: 替换顶部导航区代码**

将第 67~96 行的 `<nav>` 区域替换为：

```tsx
<nav className="space-y-0.5">
  <SidebarNavItem
    icon={<Plus className="h-4 w-4" />}
    active={isNewSessionActive}
    onClick={() => router.push("/session/new")}
  >
    {t("newSession")}
  </SidebarNavItem>
  <SidebarNavItem
    icon={<Clock className="h-4 w-4" />}
    active={isScheduledActive}
    onClick={() => router.push("/schedule")}
  >
    {t("scheduled")}
  </SidebarNavItem>
</nav>
```

同时移除未使用的 import：`Settings`, `ChevronDown`。

- [ ] **Step 4: 修改"已固定"区域，预留操作区按钮**

将第 98~109 行的"已固定"区域替换为：

```tsx
<div className="mt-8 px-2 text-[12px] font-medium text-muted-foreground">
  {t("pinned")}
</div>
<div className="mt-1 space-y-0.5 text-[14px]">
  <button
    type="button"
    className="group flex w-full items-center justify-between rounded-none px-2 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-white"
  >
    <div className="flex items-center gap-2">
      <Pin className="h-3.5 w-3.5 text-muted-foreground group-hover:text-white" />
      <span>{t("dragToPin")}</span>
    </div>
    <span className="opacity-0 transition-opacity group-hover:opacity-100">
      <MoreHorizontal className="h-3.5 w-3.5" />
    </span>
  </button>
</div>
```

需要新增 import：`MoreHorizontal` from `lucide-react`。

- [ ] **Step 5: 修改"最近"区域，预留操作区按钮**

将第 111~129 行的"最近"区域替换为：

```tsx
<div className="mt-5 px-2 text-[12px] font-medium text-muted-foreground">
  {t("recents")}
</div>
<div className="mt-1 space-y-0.5 text-[14px]">
  <button
    type="button"
    className="group flex w-full items-center justify-between rounded-none px-2 py-1.5 text-left text-foreground/80 hover:bg-accent hover:text-white"
  >
    <div className="flex items-center gap-2">
      <Grip className="h-3.5 w-3.5 text-muted-foreground group-hover:text-white" />
      <span>{t("addMarketplacePlugin")}</span>
    </div>
    <span className="opacity-0 transition-opacity group-hover:opacity-100">
      <MoreHorizontal className="h-3.5 w-3.5" />
    </span>
  </button>
  <button
    type="button"
    className="group flex w-full items-center justify-between rounded-none px-2 py-1.5 text-left text-foreground/80 hover:bg-accent hover:text-white"
  >
    <div className="flex items-center gap-2">
      <Grip className="h-3.5 w-3.5 text-muted-foreground group-hover:text-white" />
      <span>{t("respondToUserGreeting")}</span>
    </div>
    <span className="opacity-0 transition-opacity group-hover:opacity-100">
      <MoreHorizontal className="h-3.5 w-3.5" />
    </span>
  </button>
</div>
```

- [ ] **Step 6: 运行 biome 格式化**

```bash
npx biome check --write apps/web-agent/src/components/layouts/app-shell-layout.tsx apps/web-agent/src/components/common/sidebar-nav-item.tsx
```

- [ ] **Step 7: Commit**

```bash
git add apps/web-agent/src/components/layouts/app-shell-layout.tsx
git commit -m "feat(web-agent): refactor sidebar with SidebarNavItem

- 使用 SidebarNavItem 替换顶部菜单项
- 移除\"更多\"和\"个性化\"按钮
- 基于路由自动判断选中状态（/session/new、/schedule）
- 已固定和最近区域预留操作区按钮（hover 显示 MoreHorizontal）
- 统一 hover 态样式：bg-accent + text-white + 图标白色"
```

---

### Task 3: 清理国际化文案

**Files:**
- Modify: `apps/web-agent/messages/zh.json`
- Modify: `apps/web-agent/messages/en.json`

- [ ] **Step 1: 从 zh.json 移除废弃 key**

删除第 61~62 行：

```json
    "customize": "个性化",
    "more": "更多",
```

- [ ] **Step 2: 从 en.json 移除废弃 key**

删除第 61~62 行：

```json
    "customize": "Customize",
    "more": "More",
```

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "i18n(web-agent): remove unused appShell keys

移除已废弃的菜单项文案：
- appShell.more
- appShell.customize"
```

---

## Self-Review

### 1. Spec Coverage

| Spec 要求 | 对应 Task |
|-----------|-----------|
| 创建 SidebarNavItem 组件 | Task 1 |
| 选中态文字和图标白色 | Task 1 (active 样式) |
| hover 态文字和图标白色 | Task 1 (hover 样式) |
| 移除"更多"按钮 | Task 2 (替换 nav 区域) |
| 移除"个性化"按钮 | Task 2 (替换 nav 区域) |
| 基于路由的选中判断 | Task 2 (usePathname + isNewSessionActive/isScheduledActive) |
| 预留对话项操作区 | Task 2 (group-hover + opacity) |
| 清理 i18n key | Task 3 |

无遗漏。

### 2. Placeholder Scan

无 TBD、TODO、"implement later" 等占位符。所有步骤均包含完整代码和命令。

### 3. Type Consistency

- `SidebarNavItemProps` 中的 `icon` 类型为 `ReactNode`，与 `lucide-react` 图标组件返回类型一致
- `active` 为可选 boolean，默认 false
- `onClick` 为可选函数，与 button 的 onClick 类型一致
- `usePathname` 返回 `string | null`，与 `===` 比较安全

---

## 验证清单

- [ ] 首页 `/` 无任何菜单项选中
- [ ] 访问 `/session/new` 时"新会话"高亮（橙色背景 + 白色文字 + 白色图标）
- [ ] 访问 `/schedule` 时"计划任务"高亮
- [ ] 鼠标悬停在任意菜单项上时，背景变橙色，文字和图标变白色
- [ ] "已固定"和"最近"区域的对话项 hover 时右侧显示 `MoreHorizontal` 图标按钮
- [ ] 切换中英文后菜单文案正常显示，无 missing key
- [ ] `pnpm check` 或 `npx biome check` 通过
