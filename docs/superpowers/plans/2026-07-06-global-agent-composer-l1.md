# 全局 Agent 输入框改版 · L1 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 web-agent 的 agent 输入框（composer）改成 mockup 样子：统一底部动作栏（技能/连应用/权限 mock 链 + 上传 + 发送）、去格式工具栏（保留 markdown 自动可视化）、起手台顶部加 选择 Agent/工作空间 选择器壳。

**Architecture:** 重构共享组件 `ChatInput`，去掉 `minimal` 分叉与常显格式工具栏，改成 props 驱动 + 底部动作栏（`leadingActions` 槽 + 上传 + 发送 + token 环）。新增两个纯展示组件 `ComposerActions`（mock 三链）、`ComposerTargetBar`（起手台顶部 agent/工作空间选择器壳）。5 处 composer 因共享自动获得新动作栏；仅 3 处 agent 任务 composer 传 `leadingActions`，仅起手台加顶部选择器。全部 mock/壳，无后端。

**Tech Stack:** Next.js 16 (Turbopack) · React · tiptap（StarterKit 输入规则 + tiptap-markdown）· next-intl · Tailwind v4 · lucide-react · Biome。

## Global Constraints

- 面向用户字符串必须走 next-intl `useTranslations`，禁止裸字符串（`i18n-page` 规范）；新增文案键中英（zh.json / en.json）齐全。
- 每次代码变更后跑 Biome：`npx biome check --write <files>`。
- 类型检查：`npx tsc --noEmit -p apps/web-agent/tsconfig.json`，退出码必须 0。
- web-agent 无 React 组件测试基建（root jest = `testEnvironment: node`，无 jsdom/testing-library）；本 plan 不新增 React 组件测试，验收靠 typecheck + Biome + 桌面端目视。
- 视觉验证：桌面端 `pnpm dev:desktop`（连 web-agent :3001）；若样式/CSS 显示陈旧，Turbopack 缓存坑 → `rm -rf apps/web-agent/.next` 后重启 `pnpm dev:web-agent`。
- 提交用中文 conventional commits；结尾附 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 不改后端 / server-main / IM 反向通道；不接真实上传 / 真实设备列表 / 真实工作空间切换（L2/L3）。

---

## 文件结构

| 动作 | 文件 | 职责 |
|---|---|---|
| 修改 | `apps/web-agent/messages/zh.json` / `en.json` | 新增顶层 `composer` i18n 命名空间 |
| 新建 | `apps/web-agent/src/components/common/composer-actions.tsx` | mock 三链（技能/连应用/权限），作为 `leadingActions` |
| 新建 | `apps/web-agent/src/components/home/composer-target-bar.tsx` | 起手台顶部 选择 Agent（默认本地）+ 选择工作空间 壳 |
| 修改 | `apps/web-agent/src/components/common/chat-input.tsx` | 核心：去 `minimal`/格式工具栏，新增 `leadingActions` + 底部动作栏（上传+发送+token 环） |
| 修改 | `apps/web-agent/src/components/home/launcher-home.tsx` | 去旧 chips 行 + 去 `minimal`，加 `ComposerTargetBar` + `leadingActions` |
| 修改 | `apps/web-agent/src/components/session/assistant-conversation-body.tsx` | 传 `leadingActions={<ComposerActions/>}` |
| 修改 | `apps/web-agent/src/components/im/assistant-dock.tsx` | 传 `leadingActions={<ComposerActions/>}` |
| 验证（不改） | `apps/web-agent/src/components/im/im-conversation-body.tsx`、`im/new-message-view.tsx` | 消费重构后 ChatInput，回归目视，无 chips |

---

## Task 1: 新增 `composer` i18n 命名空间

**Files:**
- Modify: `apps/web-agent/messages/zh.json`
- Modify: `apps/web-agent/messages/en.json`

**Interfaces:**
- Produces: 顶层命名空间 `composer`，键：`skills` `apps` `permissions` `comingSoon` `agentLocal` `agentComingSoon` `workspaceDefault`。供 Task 2/3 的 `useTranslations("composer")` 使用。
- 上传按钮沿用 ChatInput 现有 `chatInput.attachment` 键，不在此新增。

- [ ] **Step 1: 在 zh.json 顶层加 `composer` 段**

在 `apps/web-agent/messages/zh.json` 顶层对象内（与 `home` 平级）新增：

```json
  "composer": {
    "skills": "技能",
    "apps": "连应用",
    "permissions": "权限",
    "comingSoon": "即将上线",
    "agentLocal": "本地",
    "agentComingSoon": "其他设备即将支持",
    "workspaceDefault": "默认工作区"
  },
```

- [ ] **Step 2: 在 en.json 顶层加对应 `composer` 段**

在 `apps/web-agent/messages/en.json` 顶层对象内（与 `home` 平级）新增：

```json
  "composer": {
    "skills": "Skills",
    "apps": "Connect apps",
    "permissions": "Permissions",
    "comingSoon": "Coming soon",
    "agentLocal": "Local",
    "agentComingSoon": "Other devices coming soon",
    "workspaceDefault": "Default workspace"
  },
```

- [ ] **Step 3: 校验中英键集一致**

Run:
```bash
node -e 'const z=require("./apps/web-agent/messages/zh.json").composer,e=require("./apps/web-agent/messages/en.json").composer;const zk=Object.keys(z).sort().join(","),ek=Object.keys(e).sort().join(",");console.log(zk===ek?"OK "+zk:"MISMATCH\nzh:"+zk+"\nen:"+ek)'
```
Expected: `OK apps,agentComingSoon,agentLocal,comingSoon,permissions,skills,workspaceDefault`

- [ ] **Step 4: Biome + 提交**

```bash
npx biome check --write apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git add apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): 新增 composer i18n 命名空间(agent/工作空间选择器 + mock 链)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `ComposerActions` 组件（mock 三链）

**Files:**
- Create: `apps/web-agent/src/components/common/composer-actions.tsx`

**Interfaces:**
- Consumes: `composer.{skills,apps,permissions,comingSoon}`（Task 1）。
- Produces: `export function ComposerActions(): JSX.Element` —— 无 props。渲染 3 个内联 mock 按钮（片段，供放入 ChatInput 动作栏左侧的 `leadingActions`）。Task 5/6 消费。

- [ ] **Step 1: 新建组件**

创建 `apps/web-agent/src/components/common/composer-actions.tsx`：

```tsx
"use client";

import { Blocks, ChevronDown, Link2, Shield } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Composer 前导 mock 动作链：技能 / 连应用 / 权限。
 * 均为占位（点击无副作用，title 提示即将上线），作为 ChatInput 的 leadingActions 传入。
 */
export function ComposerActions() {
  const t = useTranslations("composer");
  const items = [
    { key: "skills", icon: <Blocks className="h-3.5 w-3.5" />, label: t("skills") },
    { key: "apps", icon: <Link2 className="h-3.5 w-3.5" />, label: t("apps") },
    {
      key: "permissions",
      icon: <Shield className="h-3.5 w-3.5" />,
      label: t("permissions"),
    },
  ];
  return (
    <>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          title={t("comingSoon")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {it.icon}
          {it.label}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      ))}
    </>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p apps/web-agent/tsconfig.json`
Expected: 退出码 0（新组件暂未被引用，仅确认自身类型正确）

- [ ] **Step 3: Biome + 提交**

```bash
npx biome check --write apps/web-agent/src/components/common/composer-actions.tsx
git add apps/web-agent/src/components/common/composer-actions.tsx
git commit -m "feat(web-agent): 加 ComposerActions（技能/连应用/权限 mock 链）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `ComposerTargetBar` 组件（起手台顶部选择器壳）

**Files:**
- Create: `apps/web-agent/src/components/home/composer-target-bar.tsx`

**Interfaces:**
- Consumes: `composer.{agentLocal,agentComingSoon,comingSoon,workspaceDefault}`（Task 1）。
- Produces: `export function ComposerTargetBar(): JSX.Element` —— 无 props。渲染一行两个下拉壳（选择 Agent：默认本地；选择工作空间：默认工作区）。Task 5 消费。

- [ ] **Step 1: 新建组件**

创建 `apps/web-agent/src/components/home/composer-target-bar.tsx`：

```tsx
"use client";

import { ChevronDown, FolderClosed, MonitorSmartphone } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * 起手台 composer 顶部选择器行：选择 Agent（默认本地）+ 选择工作空间（默认工作区）。
 * L1 纯 UI 壳，无真实数据 / 无状态：其他设备与工作空间切换在 L2/后续接入。
 */
export function ComposerTargetBar() {
  const t = useTranslations("composer");
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      {/* 选择 Agent：默认本地（其他设备 L2 接入，暂 coming-soon 提示） */}
      <button
        type="button"
        title={t("agentComingSoon")}
        className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
      >
        <MonitorSmartphone className="h-3.5 w-3.5 text-(--shell-accent)" />
        {t("agentLocal")}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {/* 选择工作空间：默认工作区（agent 文件工作区，后续接真实目录） */}
      <button
        type="button"
        title={t("comingSoon")}
        className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <FolderClosed className="h-3.5 w-3.5" />
        {t("workspaceDefault")}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p apps/web-agent/tsconfig.json`
Expected: 退出码 0

- [ ] **Step 3: Biome + 提交**

```bash
npx biome check --write apps/web-agent/src/components/home/composer-target-bar.tsx
git add apps/web-agent/src/components/home/composer-target-bar.tsx
git commit -m "feat(web-agent): 加 ComposerTargetBar（起手台顶部 选择Agent/工作空间 壳）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `ChatInput` 核心重构（去 minimal/工具栏 + 动作栏）

**Files:**
- Modify (整文件替换): `apps/web-agent/src/components/common/chat-input.tsx`
- Modify: `apps/web-agent/src/components/home/launcher-home.tsx`（仅去掉 `minimal` 传参，保持编译通过；旧 chips 行留到 Task 5 处理）

**Interfaces:**
- Produces: `ChatInput` props 变化 —— 移除 `minimal`；新增 `leadingActions?: React.ReactNode`。其余 props 不变：`value/onChange/onSend?/onInterrupt?/isLoading?/placeholder?/modelName?/tokenUsage?`。`ChatInputHandle.focus` 不变。
- Consumes: 无新依赖（沿用 tiptap / lucide / `chatInput` i18n 命名空间）。

- [ ] **Step 1: 整文件替换 chat-input.tsx**

用以下内容替换 `apps/web-agent/src/components/common/chat-input.tsx` 全文（去掉格式工具栏与 `minimal`，发送/上传迁入底部动作栏，token 环并入右侧，新增 `leadingActions`）：

```tsx
"use client";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@meshbot/design";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Paperclip, Send, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Markdown } from "tiptap-markdown";
import { formatTokens } from "@/lib/format-tokens";

/** editor.storage 在挂载 tiptap-markdown 后的实际形态（类型断言辅助） */
interface MarkdownEditorStorage {
  markdown: { getMarkdown(): string };
}

/** 从 editor.storage 中安全取出 markdown 字符串 */
function getMarkdown(storage: unknown): string {
  return (storage as MarkdownEditorStorage).markdown.getMarkdown();
}

interface ChatInputProps {
  /** 受控值。父组件维护 draft state。 */
  value: string;
  /** 受控 change。 */
  onChange: (next: string) => void;
  onSend?: (message: string) => void;
  onInterrupt?: () => void;
  isLoading?: boolean;
  placeholder?: string;
  /** 底部动作栏左侧的前导动作（如 ComposerActions 的 技能/连应用/权限 mock 链）。 */
  leadingActions?: ReactNode;
  modelName?: string;
  tokenUsage?: {
    /**
     * 进度环主显示分子。语义：「下次 LLM 请求预估 input token」
     * （= 最近一次 LlmCall.input_tokens，作为下次请求的代理）。
     */
    current: number;
    max: number;
    /** 分项明细（可选）—— 提供时 Tooltip 展示详细分解。 */
    breakdown?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      reasoningTokens: number;
      callCount: number;
      /** 会话累计 token（所有调用 input+output 之和）；只在 tooltip 辅助行显示。 */
      cumulativeTokens?: number;
    };
  };
}

/** 父组件通过 ref 调用的方法。 */
export interface ChatInputHandle {
  /**
   * 聚焦输入框，光标置于内容末尾。
   *
   * 可选传入 `withText`：调用方刚 setDraft(text) 时，React state 提交是异步的，
   * 若不传值则 focus 时光标会停在旧内容末尾。
   * 传入 withText 让组件用该值计算末尾位置，再 focus 并将光标移到末尾。
   */
  focus: (withText?: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput(
    {
      value,
      onChange,
      onSend,
      onInterrupt,
      isLoading = false,
      placeholder,
      leadingActions,
      modelName,
      tokenUsage,
    },
    ref,
  ) {
    const tChat = useTranslations("chatInput");
    const tSession = useTranslations("session");

    // sendFnRef 让 handleKeyDown（在 useEditor 配置对象中捕获）
    // 始终能调用到最新的 handleSend，绕开闭包陈旧问题。
    const sendFnRef = useRef<() => void>(() => {});

    const editor = useEditor({
      immediatelyRender: false,
      extensions: [
        StarterKit,
        Placeholder.configure({
          placeholder: placeholder ?? tChat("placeholder"),
        }),
        Markdown.configure({
          transformPastedText: true,
          transformCopiedText: true,
        }),
      ],
      content: value,
      editorProps: {
        attributes: {
          class:
            "prose-none w-full text-sm text-foreground outline-none [&_p]:my-0 [&_ul]:my-1 [&_ul]:ml-4 [&_ul]:list-disc [&_ol]:my-1 [&_ol]:ml-4 [&_ol]:list-decimal [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_a]:text-accent [&_a]:underline",
        },
        // 粘贴富文本时剥掉源站内联样式（style/class/color/bgcolor/align），
        // 避免「白字 + 背景」等样式感染；标签结构保留给 Markdown 提取语义。
        transformPastedHTML: (html) =>
          html.replace(/\s(?:style|class|bgcolor|color|align)="[^"]*"/gi, ""),
        handleKeyDown: (_view, event) => {
          // IME 组合期间不拦截 Enter
          if (event.isComposing || event.keyCode === 229) return false;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendFnRef.current();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: e }) => {
        onChange(getMarkdown(e.storage));
      },
    });

    const handleSend = useCallback(() => {
      if (!editor) return;
      const md = getMarkdown(editor.storage).trim();
      if (!md) return;
      onSend?.(md);
      editor.commands.clearContent();
      onChange("");
    }, [editor, onSend, onChange]);

    // 每次 handleSend 更新时同步到 ref，让 handleKeyDown 读到最新版本
    useEffect(() => {
      sendFnRef.current = handleSend;
    }, [handleSend]);

    // 受控 value 同步守卫：防自身 onChange 回环 + 光标跳
    useEffect(() => {
      if (!editor) return;
      const current = getMarkdown(editor.storage);
      if (value !== current) {
        editor.commands.setContent(value, { emitUpdate: false });
      }
    }, [value, editor]);

    useImperativeHandle(
      ref,
      () => ({
        focus: (_withText?: string) => {
          requestAnimationFrame(() => {
            editor?.commands.focus("end");
          });
        },
      }),
      [editor],
    );

    const handleInterrupt = useCallback(() => {
      onInterrupt?.();
    }, [onInterrupt]);

    const hasContent = !!editor && !editor.isEmpty;

    const tokenPercent = tokenUsage
      ? Math.min((tokenUsage.current / tokenUsage.max) * 100, 100)
      : 0;

    return (
      <div className="overflow-hidden rounded-[10px] border border-border bg-card">
        {/* 编辑区（tiptap；StarterKit 输入规则让 markdown 边打边可视化） */}
        <div className="px-3 pt-2.5 pb-1">
          <div className="max-h-[200px] w-full overflow-y-auto py-1.5">
            <EditorContent editor={editor} />
          </div>
        </div>

        {/* 底部动作栏：左=前导动作（父传 mock 链）；右=token 环 + 上传 + 发送/中断 */}
        <div className="flex items-center gap-2 px-2.5 pb-2">
          {leadingActions && (
            <div className="flex min-w-0 items-center gap-1">{leadingActions}</div>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {tokenUsage && (
              <>
                {modelName && (
                  <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                    {modelName}
                  </span>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="h-4 w-4 cursor-pointer">
                      <svg
                        className="h-full w-full -rotate-90"
                        viewBox="0 0 36 36"
                        role="img"
                        aria-label="Token usage"
                      >
                        <path
                          className="text-border"
                          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="text-accent transition-all"
                          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                          fill="none"
                          stroke="currentColor"
                          strokeDasharray={`${tokenPercent}, 100`}
                          strokeWidth="4"
                        />
                      </svg>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    {tokenUsage.breakdown ? (
                      <div className="space-y-0.5 text-xs">
                        <div>
                          {tSession("usage.nextRequestLabel")}{" "}
                          {formatTokens(tokenUsage.current)} /{" "}
                          {formatTokens(tokenUsage.max)}
                        </div>
                        <div>
                          {tSession("usage.inputLabel")}{" "}
                          {formatTokens(tokenUsage.breakdown.inputTokens)}
                          {tokenUsage.breakdown.cacheReadTokens > 0 &&
                            `（${tSession("usage.cacheLabel")} ${formatTokens(tokenUsage.breakdown.cacheReadTokens)}）`}
                        </div>
                        <div>
                          {tSession("usage.outputLabel")}{" "}
                          {formatTokens(tokenUsage.breakdown.outputTokens)}
                          {tokenUsage.breakdown.reasoningTokens > 0 &&
                            `（${tSession("usage.reasoningLabel")} ${formatTokens(tokenUsage.breakdown.reasoningTokens)}）`}
                        </div>
                        {tokenUsage.breakdown.cumulativeTokens !== undefined && (
                          <div>
                            {tSession("usage.cumulativeLabel")}{" "}
                            {formatTokens(tokenUsage.breakdown.cumulativeTokens)}
                          </div>
                        )}
                        <div>
                          {tSession("usage.callCount", {
                            count: tokenUsage.breakdown.callCount,
                          })}
                        </div>
                      </div>
                    ) : (
                      <>
                        {formatTokens(tokenUsage.current)} /{" "}
                        {formatTokens(tokenUsage.max)}
                      </>
                    )}
                  </TooltipContent>
                </Tooltip>
              </>
            )}

            {/* 上传（mock 占位，点击无副作用；真实上传 L1 不做） */}
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={tChat("attachment")}
            >
              <Paperclip className="h-4 w-4" />
            </button>

            {/* 运行中显示中断；再显示发送键 */}
            {isLoading && (
              <button
                type="button"
                onClick={handleInterrupt}
                className="flex h-8 w-8 shrink-0 items-center justify-center text-destructive transition-colors hover:text-destructive/80"
                title={tChat("interrupt")}
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            )}
            <button
              type="button"
              onClick={handleSend}
              disabled={!hasContent}
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
                hasContent
                  ? "bg-(--shell-accent) text-white"
                  : "text-muted-foreground",
              )}
              title={tChat("send")}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    );
  },
);
```

- [ ] **Step 2: 去掉 launcher-home 的 `minimal` 传参（保编译通过）**

在 `apps/web-agent/src/components/home/launcher-home.tsx` 找到 `<ChatInput` 调用，删除 `minimal` 这一行属性（其余保持不动，旧 chips 行留到 Task 5）：

```tsx
          <ChatInput
            value={draft}
            onChange={setDraft}
            onSend={(text) => void handleSend(text)}
            isLoading={sending}
            placeholder={t("inputPlaceholders.0")}
          />
```

- [ ] **Step 3: 类型检查（确认无残留 `minimal` 引用）**

Run: `npx tsc --noEmit -p apps/web-agent/tsconfig.json`
Expected: 退出码 0（`minimal` 已从 props 移除，全仓库不应再有传参）

- [ ] **Step 4: Biome**

Run: `npx biome check --write "apps/web-agent/src/components/common/chat-input.tsx" "apps/web-agent/src/components/home/launcher-home.tsx"`
Expected: No fixes / 已格式化，无 error

- [ ] **Step 5: 目视回归（5 处 composer）**

桌面端 Cmd+R（若样式陈旧见 Global Constraints 清缓存）。逐一核对：
- 起手台：编辑区下方出现动作栏（左侧暂空 + 上传 📎 + 发送 ↑），无格式工具栏；旧「技能/连应用/权限」独立行仍在上方（Task 5 迁走）。
- 主会话 / 随手问 / IM 会话 / 新消息：均无格式工具栏；发送键在动作栏右端，上传在其左；token 环仍在（主会话/随手问）。
- 打字 `# 标题`、`**粗**`、`- 列表` 自动可视化；Enter 发送、Shift+Enter 换行、运行中中断键正常。

- [ ] **Step 6: 提交**

```bash
git add apps/web-agent/src/components/common/chat-input.tsx apps/web-agent/src/components/home/launcher-home.tsx
git commit -m "refactor(web-agent): ChatInput 去 minimal/格式工具栏,统一底部动作栏(leadingActions+上传+发送)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 起手台迁移（顶部选择器 + leadingActions + 去旧 chips 行）

**Files:**
- Modify: `apps/web-agent/src/components/home/launcher-home.tsx`

**Interfaces:**
- Consumes: `ComposerActions`（Task 2）、`ComposerTargetBar`（Task 3）、重构后 `ChatInput` 的 `leadingActions`（Task 4）。

- [ ] **Step 1: 改 launcher-home**

编辑 `apps/web-agent/src/components/home/launcher-home.tsx`：

(a) 顶部 import：删除仅用于旧 chips 行的图标（`Blocks, ChevronDown, Link2, Shield`），保留场景用的 `Coffee, Terminal, Palette`；新增两个组件 import。改后 import 区：

```tsx
"use client";

import { useSetAtom } from "jotai";
import { Coffee, Palette, Terminal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { addSessionAtom } from "@/atoms/sessions";
import { ChatInput } from "@/components/common/chat-input";
import { ComposerActions } from "@/components/common/composer-actions";
import { SuggestionChips } from "@/components/common/suggestion-chips";
import { ComposerTargetBar } from "@/components/home/composer-target-bar";
import { createSession } from "@/rest/session";
```

(b) 把「重 composer：配置条（视觉占位）+ ChatInput」整块（原 `<div className="w-full">` 内的旧 chips `<div className="mb-1.5 ...">...</div>` + `<ChatInput .../>`）替换为：

```tsx
        {/* composer：顶部选择器行 + ChatInput（动作栏内含 技能/连应用/权限 + 上传 + 发送） */}
        <div className="w-full">
          <ComposerTargetBar />
          <ChatInput
            value={draft}
            onChange={setDraft}
            onSend={(text) => void handleSend(text)}
            isLoading={sending}
            placeholder={t("inputPlaceholders.0")}
            leadingActions={<ComposerActions />}
          />
        </div>
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p apps/web-agent/tsconfig.json`
Expected: 退出码 0（无未用 import：`Blocks/ChevronDown/Link2/Shield` 已删）

- [ ] **Step 3: Biome**

Run: `npx biome check --write apps/web-agent/src/components/home/launcher-home.tsx`
Expected: No error（含 `check:dead` 不适用；未用 import 会被 Biome 标出，应无）

- [ ] **Step 4: 目视**

起手台：composer 顶部出现 `[🖥 本地 ▾] [📁 默认工作区 ▾]`；动作栏左侧出现「技能/连应用/权限」链；旧独立 chips 行已消失,不再重复。

- [ ] **Step 5: 提交**

```bash
git add apps/web-agent/src/components/home/launcher-home.tsx
git commit -m "feat(web-agent): 起手台 composer 加顶部选择器 + 技能链迁入动作栏

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 主会话 / 随手问 composer 加 leadingActions

**Files:**
- Modify: `apps/web-agent/src/components/session/assistant-conversation-body.tsx`
- Modify: `apps/web-agent/src/components/im/assistant-dock.tsx`

**Interfaces:**
- Consumes: `ComposerActions`（Task 2）、`ChatInput.leadingActions`（Task 4）。

- [ ] **Step 1: assistant-conversation-body 加 import + 传参**

在 `apps/web-agent/src/components/session/assistant-conversation-body.tsx`：
- 顶部加：`import { ComposerActions } from "@/components/common/composer-actions";`
- 给 `<ChatInput` 调用补一行属性（与现有 `ref/value/onChange/onSend/onInterrupt/isLoading/placeholder/tokenUsage` 并列）：

```tsx
          leadingActions={<ComposerActions />}
```

- [ ] **Step 2: assistant-dock 加 import + 传参**

在 `apps/web-agent/src/components/im/assistant-dock.tsx`：
- 顶部加：`import { ComposerActions } from "@/components/common/composer-actions";`
- 给其 `<ChatInput` 调用补：

```tsx
          leadingActions={<ComposerActions />}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p apps/web-agent/tsconfig.json`
Expected: 退出码 0

- [ ] **Step 4: Biome**

Run: `npx biome check --write "apps/web-agent/src/components/session/assistant-conversation-body.tsx" "apps/web-agent/src/components/im/assistant-dock.tsx"`
Expected: No error

- [ ] **Step 5: 目视**

主会话（/assistant?id=…）与随手问浮层：动作栏左侧出现「技能/连应用/权限」链，右侧 token 环 + 上传 + 发送。

- [ ] **Step 6: 提交**

```bash
git add apps/web-agent/src/components/session/assistant-conversation-body.tsx apps/web-agent/src/components/im/assistant-dock.tsx
git commit -m "feat(web-agent): 主会话/随手问 composer 加 技能/连应用/权限 mock 链

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: IM 会话回归 + 全 composer 目视验收

**Files:**
- 验证（不改）: `apps/web-agent/src/components/im/im-conversation-body.tsx`、`apps/web-agent/src/components/im/new-message-view.tsx`

**Interfaces:** 无产出，纯验收。

- [ ] **Step 1: 全量类型检查 + Biome**

Run:
```bash
npx tsc --noEmit -p apps/web-agent/tsconfig.json
npx biome check apps/web-agent/src
```
Expected: tsc 退出码 0；Biome 无 error

- [ ] **Step 2: IM 会话目视（应无 agent 链）**

桌面端进「消息」→ 某会话 / 新消息视图：
- 动作栏右端为 上传 + 发送，无格式工具栏；**左侧无「技能/连应用/权限」链**（这两处不是 agent 任务 composer，未传 leadingActions）。
- 发送/换行/键盘行为正常。

- [ ] **Step 3: 全景走查 5 处 composer 一致性**

对照 mockup 逐项确认：起手台（顶部选择器 + 三链 + 上传/发送）/ 主会话（三链 + token 环 + 上传/发送）/ 随手问（同主会话）/ IM 会话（无三链）/ 新消息（无三链）。markdown 自动可视化在所有 composer 生效。

- [ ] **Step 4: 无代码改动则不提交**

本任务仅验收；如目视发现问题，回到对应 Task 修复并重跑其验收步骤。

---

## Self-Review（作者已过一遍）

- **Spec 覆盖**：动作栏(上传移位/去工具栏) → Task 4;技能/连应用/权限 mock 链 → Task 2+5+6;顶部选择器(agent/工作空间壳) → Task 3+5;markdown 自动可视化(保 tiptap 输入规则) → Task 4;应用范围表 → Task 5/6/7;i18n → Task 1。均有对应任务。
- **占位扫描**：无 TBD/TODO;每个代码步给了完整代码/命令/预期。
- **类型一致**：`leadingActions?: ReactNode` 在 Task 4 定义,Task 5/6 消费签名一致;`ComposerActions`/`ComposerTargetBar` 均无 props,Task 2/3 定义、5/6 使用一致;`minimal` 在 Task 4 移除且同步清理唯一传参处(launcher-home)。
- **测试基建**：web-agent 无 React 组件测试 runner（已确认）；本 plan 用 typecheck + Biome + 目视验收，符合 Global Constraints。
