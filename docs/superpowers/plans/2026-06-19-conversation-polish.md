# 消息壳重构 · Plan 5：对话区精修（IM 消息流）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 IM 消息流（`im-message-list.tsx`）精修到 Slack 干净度：连续同发送者**消息分组**（仅首条显示头像+名字，后续行 hover 在左侧 gutter 显示时间）、**日期分隔条**、**悬停操作条**（复制，功能性）。纯前端。

**Architecture:** 纯前端（`apps/web-agent`）。把「分组 + 日期分隔」判定抽成纯函数 `annotateRows`（按发送者变化 + 跨天插分隔）做 TDD；`im-message-list.tsx` 据此渲染头行 vs 分组行 + 日期分隔 + hover 复制条。会话流（`session/message-list.tsx`）已富渲染（reasoning/toolCalls/feedback），不在本计划。**表情回应 / 回复·线程 / 收藏** 需后端（存储+端点+WS），与附件同列为独立后端项目，本期只做复制（前端可行）。

**Tech Stack:** React 19、next-intl、Tailwind v4、lucide-react；纯逻辑用根 Jest（`*.test.ts`，node env）TDD。

## Global Constraints

- 目标包：仅 `apps/web-agent`，不改后端 / `libs/*`。
- 复用现有：`ImMessage`（`@meshbot/types`，`{id,conversationId,senderId,content,createdAt}`）、`cn`（`@meshbot/design`）。
- `ImMessageList` 公开 props 不变：`{messages: ImMessage[], members, currentUserId}`（调用方 `messages/page.tsx` 零改动）。
- i18n：新增可见串走 next-intl（`messages` 命名空间），同时改 `messages/zh.json`+`en.json`，遵循扁平 stub 工作流；`missing=0,asymmetric=0`。无裸字符串。
- 配色用 design token（`bg-muted`、`border-border`、`text-muted-foreground`、`bg-(--shell-accent)`）。
- 视觉对照 mockup `.superpowers/brainstorm/90418-1781852822/content/02-conversation-input.html`。
- 提交中文 conventional commits，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 每个 Task 后 `pnpm --filter @meshbot/web-agent typecheck` + `pnpm lint`（含 Task 1 的 `pnpm test`）必须过。

---

### Task 1: 分组/日期分隔纯函数 + TDD

输入消息序列，输出每行的 `{showDayDivider, showHeader}`：跨天 → 分隔 + 头行；同天但换发送者 → 头行；同天同发送者 → 分组行。

**Files:**
- Create: `apps/web-agent/src/lib/message-rows.ts`
- Create: `apps/web-agent/src/lib/message-rows.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MessageRowMeta { showDayDivider: boolean; showHeader: boolean; }
  export function annotateRows(messages: { senderId: string; createdAt: string }[]): MessageRowMeta[];
  ```
- Consumes: 无（接收最小结构，便于测试）。

- [ ] **Step 1: 写失败测试**

`apps/web-agent/src/lib/message-rows.test.ts`：

```ts
import { annotateRows } from "./message-rows";

// 用不同「日期 + 正午」时间，规避时区把同一天判成两天
const m = (senderId: string, date: string) => ({ senderId, createdAt: `${date}T12:00:00.000Z` });

describe("annotateRows", () => {
  it("首条：分隔 + 头行", () => {
    expect(annotateRows([m("a", "2026-06-19")])).toEqual([
      { showDayDivider: true, showHeader: true },
    ]);
  });

  it("同天同发送者连续 → 后续为分组行（无分隔无头）", () => {
    const r = annotateRows([m("a", "2026-06-19"), m("a", "2026-06-19")]);
    expect(r[1]).toEqual({ showDayDivider: false, showHeader: false });
  });

  it("同天换发送者 → 头行（无分隔）", () => {
    const r = annotateRows([m("a", "2026-06-19"), m("b", "2026-06-19")]);
    expect(r[1]).toEqual({ showDayDivider: false, showHeader: true });
  });

  it("跨天 → 分隔 + 头行（即便同发送者）", () => {
    const r = annotateRows([m("a", "2026-06-19"), m("a", "2026-06-20")]);
    expect(r[1]).toEqual({ showDayDivider: true, showHeader: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- message-rows`
Expected: FAIL（module not found）。

- [ ] **Step 3: 写实现**

`apps/web-agent/src/lib/message-rows.ts`：

```ts
/** 每条消息行的渲染元信息（分组 + 日期分隔）。 */
export interface MessageRowMeta {
  /** 此行上方是否插日期分隔条（首条 / 跨天）。 */
  showDayDivider: boolean;
  /** 此行是否显示头部（头像 + 名字 + 时间）；分组行为 false。 */
  showHeader: boolean;
}

/** 本地日历日 key（按本地年-月-日，符合 IM 用户直觉的「同一天」）。 */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * 标注消息流的分组与日期分隔：
 * 跨天 → 分隔 + 头行；同天换发送者 → 头行；同天同发送者 → 分组行。
 */
export function annotateRows(
  messages: { senderId: string; createdAt: string }[],
): MessageRowMeta[] {
  let prevDay = "";
  let prevSender = "";
  return messages.map((msg) => {
    const dk = dayKey(msg.createdAt);
    const showDayDivider = dk !== prevDay;
    const showHeader = showDayDivider || msg.senderId !== prevSender;
    prevDay = dk;
    prevSender = msg.senderId;
    return { showDayDivider, showHeader };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- message-rows`
Expected: PASS（4 用例绿）。

- [ ] **Step 5: typecheck + lint + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`

```bash
git add apps/web-agent/src/lib/message-rows.ts apps/web-agent/src/lib/message-rows.test.ts
git commit -m "feat(web-agent): 新增 IM 消息分组/日期分隔纯函数（含单测）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: im-message-list.tsx 精修（分组 + 日期分隔 + 悬停复制）

按 `annotateRows` 渲染：日期分隔条、头行（头像+名字+时间）vs 分组行（无头像/名字，hover 在 gutter 显示时间）、hover 操作条（复制）。

**Files:**
- Modify: `apps/web-agent/src/components/im/im-message-list.tsx`
- Modify: `apps/web-agent/messages/zh.json`、`en.json`（`today`/`yesterday`/`copy`）

**Interfaces:**
- Consumes: `annotateRows`（Task 1）；`cn`（@meshbot/design）；`Copy`（lucide-react）。
- Produces: `ImMessageList` props 不变。

- [ ] **Step 1: i18n**

`messages/zh.json` 的 `messages` 命名空间补（若已存在 `copy` 则复用，勿重复键）：

```json
"today": "今天",
"yesterday": "昨天",
"copy": "复制"
```

`en.json` 同步：`"today": "Today"`、`"yesterday": "Yesterday"`、`"copy": "Copy"`。
（`messages` 命名空间已有 `copy`?——若 dup 校验报已存在，复用现有，不再加。）必要时补扁平 stub；保持 `missing=0,asymmetric=0`。

- [ ] **Step 2: 重写 im-message-list.tsx**

整文件替换为：

```tsx
import type { ImMessage } from "@meshbot/types";
import { cn } from "@meshbot/design";
import { Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import { annotateRows } from "@/lib/message-rows";

interface ImMessageListProps {
  messages: ImMessage[];
  /** userId → sender info, for name and avatar initial */
  members: Record<string, { displayName: string; email: string }>;
  /** current user's id — own messages get a green avatar */
  currentUserId: string;
}

/** ISO → HH:MM（本地）。 */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 同一本地日历日。 */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 日期分隔标签：今天 / 昨天 / 本地日期。 */
function dayLabel(iso: string, today: string, yesterday: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (isSameDay(d, now)) return today;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (isSameDay(d, y)) return yesterday;
  return d.toLocaleDateString();
}

/**
 * IM 消息列表（Slack 行式 + 精修）：消息分组（连续同发送者仅首条显头像+名字，
 * 后续行 hover 在左 gutter 显时间）+ 日期分隔条 + hover 复制。纯展示组件。
 */
export function ImMessageList({
  messages,
  members,
  currentUserId,
}: ImMessageListProps) {
  const t = useTranslations("messages");
  if (messages.length === 0) return null;

  const rows = annotateRows(messages);

  return (
    <div className="flex flex-col pb-6">
      {messages.map((m, i) => {
        const meta = rows[i];
        const sender = members[m.senderId];
        const displayName = sender?.displayName ?? m.senderId;
        const initial = displayName.charAt(0).toUpperCase();
        const isSelf = m.senderId === currentUserId;

        return (
          <Fragment key={m.id}>
            {meta.showDayDivider && (
              <div className="my-3 flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {dayLabel(m.createdAt, t("today"), t("yesterday"))}
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}

            <div
              className={cn(
                "group relative -mx-2 flex gap-3 rounded px-2 hover:bg-muted/40",
                meta.showHeader ? "mt-2" : "mt-0.5",
              )}
            >
              {/* 左 gutter：头行=头像；分组行=hover 时间 */}
              {meta.showHeader ? (
                <div
                  className={cn(
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[12px] font-semibold text-white",
                    isSelf ? "bg-[#16a34a]" : "bg-(--shell-accent)",
                  )}
                >
                  {initial}
                </div>
              ) : (
                <div className="w-7 shrink-0 pt-0.5 text-right text-[9px] leading-5 text-muted-foreground opacity-0 group-hover:opacity-100">
                  {formatTime(m.createdAt)}
                </div>
              )}

              <div className="min-w-0 flex-1">
                {meta.showHeader && (
                  <div className="mb-0.5 flex items-baseline gap-2">
                    <span className="text-[13px] font-bold text-foreground">
                      {displayName}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatTime(m.createdAt)}
                    </span>
                  </div>
                )}
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {m.content}
                </div>
              </div>

              {/* hover 操作条：复制（功能性）。表情/回复/收藏待后端，后续计划。 */}
              <div className="absolute -top-3 right-2 hidden gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-sm group-hover:flex">
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(m.content)}
                  title={t("copy")}
                  aria-label={t("copy")}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`
Expected: 通过。

- [ ] **Step 4: 视觉确认**

`pnpm dev:web-agent` → 打开一个有多条消息的频道/私信：连续同人消息只首条有头像+名字，后续行 hover 左侧显时间；不同人/跨天起新头；跨天有日期分隔（今天/昨天/日期）；hover 消息右上出现复制按钮，点击复制正文。对照 mockup `02-conversation-input.html`。

- [ ] **Step 5: 提交**

```bash
git add apps/web-agent/src/components/im/im-message-list.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): IM 消息流精修（分组 + 日期分隔 + 悬停复制）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 非本计划范围

- 表情回应（reaction pills）、回复/线程、收藏——均需后端（存储 + 端点 + WS），与附件同列为独立后端项目；本期 hover 条只做复制。
- 会话流（`session/message-list.tsx`）精修——已富渲染（reasoning/toolCalls/feedback/markdown），本计划不动。
- 日期分隔的「本周内显示星期几」等更细的相对格式——暂用 今天/昨天/本地日期。

## Self-Review（对照 spec + 决策）

- **覆盖**：spec 需求 1 的「对话内容列表精修」→ Task 1（分组/分隔逻辑）+ Task 2（渲染 + hover 复制）。表情/回复/收藏按既定决策（需后端）显式排除，hover 条保留复制这一前端可行项。
- **接口不变**：`ImMessageList` props 不变 → `messages/page.tsx` 零改动。
- **占位符扫描**：无 TBD；「hover 条仅复制」「会话流不动」「相对日期从简」均为显式简化并说明。
- **类型一致**：`annotateRows`（Task 1）签名与 Task 2 调用一致（接收 `{senderId,createdAt}[]`，`ImMessage` 兼容）；`MessageRowMeta` 字段在 Task 2 渲染处一致。
- **风险**：`annotateRows` 用本地 `dayKey`（测试用正午 UTC 不同日期规避时区翻天）；`navigator.clipboard?.` 可选链兜底无 clipboard 环境；hover 用 `group`/`group-hover`，分组行 gutter 与头行头像同宽（w-7）保证内容左缘对齐。
