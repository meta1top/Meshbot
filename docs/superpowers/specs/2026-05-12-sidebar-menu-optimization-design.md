# 左侧菜单优化设计文档

## 背景

当前 `web-agent` 桌面端的左侧菜单存在以下问题：
1. 选中状态下文字和图标颜色未正确显示为白色（深色模式下正常，浅色模式下异常）
2. "更多"按钮需要移除
3. 鼠标经过（hover）时文字和图标颜色应为白色
4. 需要预留对话项的操作区（下拉菜单）

## 目标

优化左侧菜单的视觉表现和交互体验，统一选中态和 hover 态的样式，支持基于路由的选中状态判断。

## 设计详情

### 1. 组件结构

```
apps/web-agent/src/components/
├── common/
│   └── sidebar-nav-item.tsx      # 新增：可复用的导航项组件
├── layouts/
│   ├── app-shell-layout.tsx      # 修改：使用新组件，接入路由判断
│   └── auth-shell-layout.tsx     # 不受影响
```

### 2. SidebarNavItem 组件

**位置**：`apps/web-agent/src/components/common/sidebar-nav-item.tsx`

**Props 接口**：
```tsx
interface SidebarNavItemProps {
  icon: React.ReactNode;      // 图标元素
  children: React.ReactNode;  // 文字内容
  active?: boolean;           // 是否选中
  onClick?: () => void;       // 点击回调
  className?: string;         // 额外类名
}
```

**样式规则**：
- 默认状态：`text-foreground/80`，图标 `text-muted-foreground`
- 选中状态：`bg-accent font-medium text-white`，图标 `text-white`
- hover 状态：`hover:bg-accent hover:text-white`，图标 `hover:text-white`
- 统一使用 `transition-colors` 实现平滑过渡

### 3. AppShellLayout 修改

#### 3.1 顶部导航区

保留两个菜单项，移除"更多"和"个性化"：

| 菜单项 | 路由 | 图标 |
|--------|------|------|
| 新会话 | `/session/new` | `Plus` |
| 计划任务 | `/schedule` | `Clock` |

**选中状态判断逻辑**：
- 首页 `/`：无任何菜单项选中
- `/session/new`：新会话选中
- `/schedule`：计划任务选中
- `/session/{sessionId}`：对应的会话项在"已固定"或"最近"区域中高亮

#### 3.2 "已固定"和"最近"区域

每个对话项右侧预留操作区：

```tsx
<div className="flex w-full items-center justify-between ...">
  <div className="flex items-center gap-2">
    <Pin className="h-3.5 w-3.5" />
    <span>对话标题</span>
  </div>
  {/* 预留：下拉菜单按钮 */}
  <button className="opacity-0 group-hover:opacity-100 ...">
    <MoreHorizontal className="h-3.5 w-3.5" />
  </button>
</div>
```

**下拉菜单功能**（后续实现）：
- 修改标题
- 删除
- 固定 / 取消固定

当前阶段仅预留按钮位置和 hover 显示效果，下拉菜单内容后续迭代。

### 4. 样式变量

使用现有设计系统变量，无需新增：
- `bg-accent` → 主题色背景（橙色 `#f97316`）
- `text-white` → 选中/hover 文字颜色
- `text-muted-foreground` → 默认图标颜色
- `text-foreground/80` → 默认文字颜色

### 5. 国际化

无需新增 i18n key，沿用现有：
- `appShell.newSession`
- `appShell.scheduled`
- `appShell.pinned`
- `appShell.dragToPin`
- `appShell.recents`

移除以下 key（从 zh.json 和 en.json 中清理）：
- `appShell.more`
- `appShell.customize`

## 实现范围

### 本次实现
- [ ] 创建 `SidebarNavItem` 组件
- [ ] 修改 `AppShellLayout` 使用新组件
- [ ] 移除"更多"和"个性化"按钮
- [ ] 实现基于路由的选中状态判断
- [ ] 统一选中态和 hover 态样式（白色文字+图标）
- [ ] 预留对话项操作区按钮位置
- [ ] 清理 `appShell.more` i18n key

### 后续迭代
- [ ] 对话项下拉菜单功能（修改标题、删除、固定/取消固定）
- [ ] 已固定和最近列表的数据接入（当前为静态占位）

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/web-agent/src/components/common/sidebar-nav-item.tsx` | 新增 | 可复用导航项组件 |
| `apps/web-agent/src/components/layouts/app-shell-layout.tsx` | 修改 | 接入新组件和路由判断 |
| `apps/web-agent/messages/zh.json` | 修改 | 移除 `appShell.more`、`appShell.customize` |
| `apps/web-agent/messages/en.json` | 修改 | 移除 `appShell.more`、`appShell.customize` |
