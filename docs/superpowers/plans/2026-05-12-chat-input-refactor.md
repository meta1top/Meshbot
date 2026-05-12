# 底部输入框重构与路由调整实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提取 ChatInput 公共组件，将底部输入框从 AppShellLayout 移到首页，移除 /session/new 路由。

**Architecture:** ChatInput 作为独立可复用组件，AppShellLayout 只负责布局框架，首页 / 包含概览面板 + ChatInput。

**Tech Stack:** Next.js 15, React 19, Tailwind CSS v4, shadcn/ui, next-intl, lucide-react

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `apps/web-agent/src/components/common/chat-input.tsx` | 创建 | 聊天输入框组件 |
| `apps/web-agent/src/components/layouts/app-shell-layout.tsx` | 修改 | 移除 footer，调整路由判断 |
| `apps/web-agent/src/app/page.tsx` | 修改 | 保留概览面板 + 添加 ChatInput |
| `apps/web-agent/src/app/schedule/page.tsx` | 修改 | 不使用 ChatInput |
| `apps/web-agent/src/app/session/new/page.tsx` | 删除 | 移除该路由 |
| `apps/web-agent/messages/zh.json` | 修改 | 新增 chatInput key |
| `apps/web-agent/messages/en.json` | 修改 | 新增 chatInput key |

---

### Task 1: 创建 ChatInput 组件

**Files:**
- Create: `apps/web-agent/src/components/common/chat-input.tsx`

- [ ] **Step 1: 编写 ChatInput 组件**

```tsx
"use client";

import { cn } from "@meshbot/design";
import { Paperclip, Send, Square } from "lucide-react";
import { useCallback, useRef, useState } from "react";

interface ChatInputProps {
  onSend?: (message: string) => void;
  onInterrupt?: () => void;
  isLoading?: boolean;
  placeholder?: string;
  modelName?: string;
  tokenUsage?: { current: number; max: number };
}

export function ChatInput({
  onSend,
  onInterrupt,
  isLoading = false,
  placeholder = "描述一个任务或提出一个问题",
  modelName = "Flash · Medium",
  tokenUsage,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    onSend?.(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, isLoading, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value);
      const el = e.target;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    },
    [],
  );

  const tokenPercent = tokenUsage
    ? Math.min((tokenUsage.current / tokenUsage.max) * 100, 100)
    : 0;

  return (
    <div className="space-y-2">
      <div className="rounded-none border border-border bg-card">
        <div className="flex items-end gap-2 px-4 py-3">
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            title="添加附件"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent text-[15px] text-foreground placeholder:text-muted-foreground outline-none"
          />
          <button
            type="button"
            onClick={isLoading ? onInterrupt : handleSend}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center transition-colors",
              isLoading
                ? "text-destructive hover:text-destructive/80"
                : value.trim()
                  ? "text-foreground hover:text-foreground/80"
                  : "text-muted-foreground hover:text-foreground",
            )}
            title={isLoading ? "中断" : "发送"}
          >
            {isLoading ? (
              <Square className="h-4 w-4 fill-current" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
        <span>{modelName}</span>
        {tokenUsage && (
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-16 overflow-hidden bg-border">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${tokenPercent}%` }}
              />
            </div>
            <span>
              {tokenUsage.current}K / {tokenUsage.max}K
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 运行 biome 格式化**

```bash
npx biome check --write apps/web-agent/src/components/common/chat-input.tsx
```

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/components/common/chat-input.tsx
git commit -m "feat(web-agent): add ChatInput component

- 支持多行输入，Shift+Enter 换行，Enter 发送
- 附件按钮、发送/中断按钮
- 模型名称和 token 使用量显示
- 自适应高度 textarea"
```

---

### Task 2: 修改 AppShellLayout

**Files:**
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`

- [ ] **Step 1: 移除 footer 区域**

删除第 174~197 行的 `<footer>` 区域（从 `<footer className="absolute...` 到 `</footer>`）。

- [ ] **Step 2: 调整路由判断**

将第 36 行：
```tsx
const isNewSessionActive = pathname === "/session/new";
```
改为：
```tsx
const isNewSessionActive = pathname === "/";
```

- [ ] **Step 3: 调整新会话点击跳转**

将第 74 行：
```tsx
onClick={() => router.push("/session/new")}
```
改为：
```tsx
onClick={() => router.push("/")}
```

- [ ] **Step 4: 移除未使用的 import 和变量**

检查并移除 `appShell-layout.tsx` 中不再使用的：
- `promptPlaceholder`、`local`、`modelBadge` 等 i18n key 的引用（如果只在 footer 中使用）
- 注意：`t("logout")` 等仍在使用，不要误删

实际上 footer 移除后，`t` 仍然用于侧边栏的 `logout`、`newSession`、`scheduled` 等，所以 `t` 仍然需要。但检查是否有仅用于 footer 的变量。

- [ ] **Step 5: 调整内容区域底部内边距**

将第 169 行：
```tsx
<div className="mx-auto w-full max-w-[900px] px-5 pt-6 pb-40 lg:px-10">
```
改为：
```tsx
<div className="mx-auto w-full max-w-[900px] px-5 pt-6 pb-6 lg:px-10">
```

- [ ] **Step 6: 运行 biome 格式化**

```bash
npx biome check --write apps/web-agent/src/components/layouts/app-shell-layout.tsx
```

- [ ] **Step 7: Commit**

```bash
git add apps/web-agent/src/components/layouts/app-shell-layout.tsx
git commit -m "refactor(web-agent): remove footer from AppShellLayout

- 移除 footer 输入框区域
- 调整 isNewSessionActive 判断为 pathname === /
- 新会话点击跳转到 /
- 减少内容区域底部内边距"
```

---

### Task 3: 修改首页 /

**Files:**
- Modify: `apps/web-agent/src/app/page.tsx`

- [ ] **Step 1: 添加 ChatInput import**

在现有 import 后添加：
```tsx
import { ChatInput } from "@/components/common/chat-input";
```

- [ ] **Step 2: 在概览面板下方添加 ChatInput**

在 `</AppShellLayout>` 之前（第 87 行之前），添加：
```tsx
      <div className="mt-8">
        <ChatInput
          onSend={(msg) => console.log("send:", msg)}
          modelName="Flash · Medium"
          tokenUsage={{ current: 12, max: 128 }}
        />
      </div>
```

- [ ] **Step 3: 运行 biome 格式化**

```bash
npx biome check --write apps/web-agent/src/app/page.tsx
```

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/src/app/page.tsx
git commit -m "feat(web-agent): add ChatInput to home page

- 保留概览面板
- 在概览面板下方添加 ChatInput 组件"
```

---

### Task 4: 修改 /schedule 页面

**Files:**
- Modify: `apps/web-agent/src/app/schedule/page.tsx`

- [ ] **Step 1: 确认不使用 ChatInput**

当前 `/schedule/page.tsx` 内容：
```tsx
"use client";

import { AppShellLayout } from "@/components/layouts/app-shell-layout";

export default function SchedulePage() {
  return (
    <AppShellLayout>
      <div className="flex h-full items-center justify-center text-muted-foreground">
        计划任务
      </div>
    </AppShellLayout>
  );
}
```

这个页面已经符合要求（不使用 ChatInput）。但可能需要调整底部内边距，因为 AppShellLayout 已经移除了 `pb-40`。

- [ ] **Step 2: Commit（如有修改）**

如果有修改则提交，否则跳过。

---

### Task 5: 删除 /session/new 路由

**Files:**
- Delete: `apps/web-agent/src/app/session/new/page.tsx`

- [ ] **Step 1: 删除文件和目录**

```bash
rm -rf apps/web-agent/src/app/session/new
```

- [ ] **Step 2: Commit**

```bash
git add apps/web-agent/src/app/session/new
git commit -m "chore(web-agent): remove /session/new route

首页 / 即为新建会话页面"
```

---

### Task 6: 新增国际化文案

**Files:**
- Modify: `apps/web-agent/messages/zh.json`
- Modify: `apps/web-agent/messages/en.json`

- [ ] **Step 1: 在 zh.json 中添加 chatInput key**

在 `"home": {` 之前添加：
```json
  "chatInput": {
    "placeholder": "描述一个任务或提出一个问题",
    "send": "发送",
    "interrupt": "中断",
    "attachment": "添加附件"
  },
```

- [ ] **Step 2: 在 en.json 中添加 chatInput key**

在 `"home": {` 之前添加：
```json
  "chatInput": {
    "placeholder": "Describe a task or ask a question",
    "send": "Send",
    "interrupt": "Interrupt",
    "attachment": "Add attachment"
  },
```

- [ ] **Step 3: 运行 biome 格式化**

```bash
npx biome check --write apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
```

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "i18n(web-agent): add chatInput keys

新增聊天输入框相关文案：
- placeholder, send, interrupt, attachment"
```

---

## Self-Review

### 1. Spec Coverage

| Spec 要求 | 对应 Task |
|-----------|-----------|
| 创建 ChatInput 组件 | Task 1 |
| AppShellLayout 移除 footer | Task 2 |
| 调整 isNewSessionActive 为 `/` | Task 2 |
| 首页保留概览面板 + ChatInput | Task 3 |
| /schedule 不使用 ChatInput | Task 4 |
| 删除 /session/new | Task 5 |
| 新增 i18n key | Task 6 |

无遗漏。

### 2. Placeholder Scan

无 TBD、TODO、"implement later" 等占位符。

### 3. Type Consistency

- `ChatInputProps` 类型与使用场景一致
- `tokenUsage` 为可选，不影响无 token 显示的场景

---

## 验证清单

- [ ] 访问 `/` 时"新会话"菜单高亮
- [ ] 首页显示概览面板 + ChatInput
- [ ] ChatInput 支持 Shift+Enter 换行、Enter 发送
- [ ] 输入内容后发送按钮高亮
- [ ] /schedule 页面不显示 ChatInput
- [ ] /session/new 返回 404
- [ ] 切换中英文后 ChatInput placeholder 正常显示
- [ ] `pnpm check` 或 `npx biome check` 通过
