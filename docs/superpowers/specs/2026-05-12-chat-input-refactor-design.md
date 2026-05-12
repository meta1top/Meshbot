# 底部输入框重构与路由调整设计文档

## 背景

当前 `AppShellLayout` 的 footer 区域（第 174~197 行）包含了一个固定的输入框和状态栏，这不应该在布局组件中，而应由具体页面决定是否需要显示。同时需要：
1. 将底部输入框抽象为可复用的 `ChatInput` 组件
2. 移除 `/session/new` 路由，首页 `/` 即为新建会话页面
3. 新建会话时保留概览面板

## 目标

- 提取 `ChatInput` 公共组件
- `AppShellLayout` 只负责布局框架，不再包含输入框
- 首页 `/` 包含概览面板 + ChatInput
- `/schedule` 不使用 ChatInput
- 路由简化：`/` = 新建会话

## 设计详情

### 1. 组件结构

```
apps/web-agent/src/
├── components/
│   ├── common/
│   │   ├── sidebar-nav-item.tsx      # 已存在
│   │   └── chat-input.tsx            # 新增：聊天输入框组件
│   └── layouts/
│       └── app-shell-layout.tsx      # 修改：移除 footer
├── app/
│   ├── page.tsx                      # 修改：保留概览面板 + 添加 ChatInput
│   ├── schedule/
│   │   └── page.tsx                  # 修改：不使用 ChatInput
│   └── session/                      # 删除：/session/new 目录
└── messages/
    ├── zh.json                       # 新增 i18n key
    └── en.json                       # 新增 i18n key
```

### 2. ChatInput 组件

**位置**：`apps/web-agent/src/components/common/chat-input.tsx`

**Props 接口**：
```tsx
interface ChatInputProps {
  onSend?: (message: string) => void;
  onInterrupt?: () => void;
  isLoading?: boolean;
  placeholder?: string;
  modelName?: string;
  tokenUsage?: { current: number; max: number };
}
```

**布局与样式**：
- 外框：`rounded-none border border-border bg-card px-4 py-3`
- 输入区：`textarea`，自适应高度，placeholder 使用 `text-muted-foreground`
- 左侧按钮：附件图标（`Paperclip`），`text-muted-foreground hover:text-foreground`
- 右侧按钮：
  - 发送状态：`Send` 图标（`text-muted-foreground hover:text-foreground`）
  - 生成中状态：`Square` 图标（中断按钮）
- 键盘交互：`Shift+Enter` 换行，`Enter` 发送
- 下方信息栏：
  - 左侧：模型名称（如 "Flash · Medium"），`text-xs text-muted-foreground`
  - 右侧：token 使用量进度条 + 数值，`text-xs text-muted-foreground`

### 3. AppShellLayout 修改

**移除内容**：
- 第 174~197 行的 `<footer>` 区域（输入框 + 状态标签）

**保留内容**：
- 左侧边栏（导航、已固定、最近、底部操作栏）
- 右侧内容区域框架

**路由选中判断调整**：
```tsx
const isNewSessionActive = pathname === "/";
```

### 4. 首页 `/` 调整

**位置**：`apps/web-agent/src/app/page.tsx`

**内容**：
- 保留现有概览面板（热力图、指标卡片等）
- 在概览面板下方添加 `ChatInput` 组件
- 移除 `pb-40` 的底部内边距（因为输入框不再固定在布局中）

### 5. `/schedule` 页面

**位置**：`apps/web-agent/src/app/schedule/page.tsx`

**内容**：
- 不使用 `ChatInput`
- 保持简单的占位内容

### 6. 删除 `/session/new`

删除 `apps/web-agent/src/app/session/new/` 目录及其内容。

### 7. 国际化

新增 i18n key：
- `chatInput.placeholder`：输入框占位文案
- `chatInput.send`：发送按钮 aria-label
- `chatInput.interrupt`：中断按钮 aria-label
- `chatInput.attachment`：附件按钮 aria-label

## 实现范围

### 本次实现
- [ ] 创建 `ChatInput` 组件
- [ ] 修改 `AppShellLayout` 移除 footer
- [ ] 调整 `isNewSessionActive` 路由判断为 `pathname === "/"`
- [ ] 修改首页 `/` 保留概览面板 + 添加 ChatInput
- [ ] 修改 `/schedule` 页面（不使用 ChatInput）
- [ ] 删除 `/session/new` 目录
- [ ] 新增 i18n key
- [ ] 调整 `AppShellLayout` 的 `pb-40` 内边距

### 后续迭代
- [ ] ChatInput 的实际发送逻辑（接入 API）
- [ ] token 使用量的实时计算
- [ ] 附件上传功能

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/web-agent/src/components/common/chat-input.tsx` | 新增 | 聊天输入框组件 |
| `apps/web-agent/src/components/layouts/app-shell-layout.tsx` | 修改 | 移除 footer，调整路由判断 |
| `apps/web-agent/src/app/page.tsx` | 修改 | 保留概览面板 + 添加 ChatInput |
| `apps/web-agent/src/app/schedule/page.tsx` | 修改 | 不使用 ChatInput |
| `apps/web-agent/src/app/session/new/page.tsx` | 删除 | 移除该路由 |
| `apps/web-agent/messages/zh.json` | 修改 | 新增 chatInput key |
| `apps/web-agent/messages/en.json` | 修改 | 新增 chatInput key |
