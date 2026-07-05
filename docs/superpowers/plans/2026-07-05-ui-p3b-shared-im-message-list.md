# UI 重构 P3b:统一 IM 消息列表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 web-agent(Slack 行式 + markdown)和 web-main(气泡 + 纯文本)**各写一份的 `im-message-list`** 合成 `@meshbot/web-common/im` 里一个纯展示组件,消掉两端重复(含重复的 `annotateRows`),布局差异用 `variant` 覆盖、数据/渲染差异用注入 prop 解耦。

**Architecture:** 共享 `ImMessageList({ messages, variant, groupKey, resolveSender, renderContent, labels, onCopy })`——`variant:"rows"|"bubbles"` 切两套布局(内部 `RowsItem`/`BubbleItem`);`groupKey` 参数化分组键(行式 senderId、气泡 senderType);`resolveSender` 抹平"members+currentUserId vs agentName+senderType"差异;`renderContent` 让 web-agent 注入 `MarkdownContent`(重依赖不进共享包)、web-main 注入纯文本;`labels` 让 i18n 命名空间解耦。放 `@meshbot/web-common/im` 源码直连子入口(同 P3a 的 `./shell`)。

**Tech Stack:** TypeScript(NodeNext)· React 19 · Tailwind v4(`@source`)· pnpm workspace。

## Global Constraints

- **落点 `@meshbot/web-common/im`,源码直连**(export 指向 `./src/im/index.ts`,同 `./shell`)。
- **纯展示 + 注入**:共享组件只 `cn`(design)/`lucide-react`/`react`/`@meshbot/types`(ImMessage 类型);**不引** markdown 库、atoms、rest、i18n 命名空间——这些经 `renderContent`/`labels`/`resolveSender` 注入。
- **两端行为/视觉零回归**:web-agent 仍行式+markdown+hover 复制;web-main 仍气泡+纯文本+左右分。合并后逐像素一致。
- **分组键参数化**:`annotateRows(messages, groupKey)`;web-agent `m=>m.senderId`、web-main `m=>m.senderType`。
- **MarkdownContent 不搬**(react-markdown/rehype/remark 重依赖留 web-agent,注入)。
- **两端都要接线**:各自 globals.css 加 `@source` 扫 `web-common/src/im`(否则 class 静默丢失——P3a 终审教训);两端 `transpilePackages` 已含 `@meshbot/web-common`(web-agent/web-main 都已确认),无需改。
- **验证**:`pnpm --filter @meshbot/web-common typecheck` + 两 app `typecheck`&`build` + 人工冒烟(web-agent IM 3001 / web-main IM 3002 消息渲染不变)。
- 禁 `--no-verify`;中文 commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;分支 `feat/ui-p3a-shared-leaves`(P3a+P3b 同分支)。

## 依赖与命令
web-common typecheck:`pnpm --filter @meshbot/web-common typecheck`。web-agent/web-main:`pnpm --filter @meshbot/web-agent typecheck`/`build`、`pnpm --filter @meshbot/web-main typecheck`/`build`(timeout 600000)。冒烟 `pnpm dev:web-agent`(3001)/`pnpm dev:web-main`(3002)。

---

## File Structure

| 文件 | 改动 | 职责 |
|------|------|------|
| `packages/web-common/src/im/message-rows.ts` | 建 | 共享 `MessageRowMeta`/`annotateRows(msgs,groupKey)`/`formatTime`/`dayLabel` |
| `packages/web-common/src/im/im-message-list.tsx` | 建 | 统一 `ImMessageList`(variant + 注入)+ `RowsItem`/`BubbleItem` |
| `packages/web-common/src/im/index.ts` | 建 | 桶导出 |
| `packages/web-common/package.json` | 改 | 加 `./im` 源码导出 |
| `apps/web-agent/src/components/im/im-conversation-body.tsx` | 改 | 用共享 ImMessageList(variant rows) |
| `apps/web-agent/src/components/im/im-message-list.tsx` | 删 | 迁至共享 |
| `apps/web-agent/src/lib/message-rows.ts` | 删(若仅此消费) | annotateRows 迁至共享 |
| `apps/web-agent/src/app/globals.css` | 改 | 加 `@source` 扫 web-common/src/im |
| `apps/web-main/src/components/im/im-conversation.tsx` | 改 | 用共享 ImMessageList(variant bubbles) |
| `apps/web-main/src/components/im/im-message-list.tsx` | 删 | 迁至共享(含内联 annotateRows) |
| `apps/web-main/src/app/globals.css` | 改 | 加 `@source` 扫 web-common/src/im |

---

## Task 1:建共享 `@meshbot/web-common/im`(apps 暂不动)

**Files:**
- Create: `packages/web-common/src/im/message-rows.ts`、`im-message-list.tsx`、`index.ts`
- Modify: `packages/web-common/package.json`(加 `./im` 导出)

- [ ] **Step 1:message-rows 助手** — 新建 `packages/web-common/src/im/message-rows.ts`:

```ts
/** 每条消息行的渲染元信息(分组 + 日期分隔)。 */
export interface MessageRowMeta {
  showDayDivider: boolean;
  showHeader: boolean;
}

/** 本地日历日 key(年-月-日)。 */
function dayKey(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 标注分组 + 日期分隔;groupKey 决定"换发送者"的判据(行式 senderId、气泡 senderType)。 */
export function annotateRows<T extends { createdAt: string }>(
  messages: T[],
  groupKey: (m: T) => string,
): MessageRowMeta[] {
  let prevDay = "";
  let prevKey = "";
  return messages.map((m) => {
    const dk = dayKey(m.createdAt);
    const showDayDivider = dk !== prevDay;
    const k = groupKey(m);
    const showHeader = showDayDivider || k !== prevKey;
    prevDay = dk;
    prevKey = k;
    return { showDayDivider, showHeader };
  });
}

/** ISO → HH:MM(24h,显式 locale + hour12,避免环境 locale 漂移)。 */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 日期分隔标签:今天 / 昨天 / 本地日期(不依赖环境 locale)。 */
export function dayLabel(iso: string, today: string, yesterday: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (isSameDay(d, now)) return today;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (isSameDay(d, y)) return yesterday;
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
```

- [ ] **Step 2:统一 ImMessageList** — 新建 `packages/web-common/src/im/im-message-list.tsx`:

```tsx
import { cn } from "@meshbot/design";
import type { ImMessage } from "@meshbot/types";
import { Copy } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import {
  annotateRows,
  dayLabel,
  formatTime,
  type MessageRowMeta,
} from "./message-rows";

/** 发送者展示信息(由各 app 从自己的数据源解析注入)。 */
export interface ImMessageSender {
  displayName: string;
  initial: string;
  /** 自己发的:行式→绿头像;气泡→靠右绿泡。 */
  isSelf: boolean;
}

export interface ImMessageListLabels {
  today: string;
  yesterday: string;
  /** 仅 rows variant 的复制按钮 aria/title。 */
  copy?: string;
}

export interface ImMessageListProps {
  messages: ImMessage[];
  variant: "rows" | "bubbles";
  /** 分组键:行式 m=>m.senderId、气泡 m=>m.senderType。 */
  groupKey: (m: ImMessage) => string;
  resolveSender: (m: ImMessage) => ImMessageSender;
  /** 渲染正文:web-agent 注入 MarkdownContent、web-main 注入纯文本。 */
  renderContent: (m: ImMessage) => ReactNode;
  labels: ImMessageListLabels;
  /** rows variant 的复制回调(不传则不显复制条)。 */
  onCopy?: (m: ImMessage) => void;
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="my-3 flex items-center gap-3">
      <div className="h-px flex-1 bg-border" />
      <span className="rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/** 统一 IM 消息列表:分组 + 日期分隔共享,布局按 variant 分行式/气泡。纯展示。 */
export function ImMessageList({
  messages,
  variant,
  groupKey,
  resolveSender,
  renderContent,
  labels,
  onCopy,
}: ImMessageListProps) {
  if (messages.length === 0) return null;
  const rows = annotateRows(messages, groupKey);
  return (
    <div
      className={cn(
        "flex flex-col",
        variant === "rows" ? "pb-6" : "gap-0.5 pb-2",
      )}
    >
      {messages.map((m, i) => {
        const meta = rows[i];
        const sender = resolveSender(m);
        return (
          <Fragment key={m.id}>
            {meta.showDayDivider && (
              <DayDivider
                label={dayLabel(m.createdAt, labels.today, labels.yesterday)}
              />
            )}
            {variant === "rows" ? (
              <RowsItem
                m={m}
                meta={meta}
                sender={sender}
                renderContent={renderContent}
                copyLabel={labels.copy}
                onCopy={onCopy}
              />
            ) : (
              <BubbleItem
                m={m}
                meta={meta}
                sender={sender}
                renderContent={renderContent}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function RowsItem({
  m,
  meta,
  sender,
  renderContent,
  copyLabel,
  onCopy,
}: {
  m: ImMessage;
  meta: MessageRowMeta;
  sender: ImMessageSender;
  renderContent: (m: ImMessage) => ReactNode;
  copyLabel?: string;
  onCopy?: (m: ImMessage) => void;
}) {
  return (
    <div
      className={cn(
        "group relative -mx-2 flex gap-3 rounded px-2 py-1.5 hover:bg-muted/40",
        meta.showHeader ? "mt-1.5" : "mt-0",
      )}
    >
      {meta.showHeader ? (
        <div
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[12px] font-semibold text-white",
            sender.isSelf ? "bg-[#16a34a]" : "bg-(--shell-accent)",
          )}
        >
          {sender.initial}
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
              {sender.displayName}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {formatTime(m.createdAt)}
            </span>
          </div>
        )}
        <div className="text-sm leading-relaxed text-foreground">
          {renderContent(m)}
        </div>
      </div>
      {onCopy && (
        <div className="absolute top-1 right-2 z-10 hidden gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-xs group-hover:flex">
          <button
            type="button"
            onClick={() => onCopy(m)}
            title={copyLabel}
            aria-label={copyLabel}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function BubbleItem({
  m,
  meta,
  sender,
  renderContent,
}: {
  m: ImMessage;
  meta: MessageRowMeta;
  sender: ImMessageSender;
  renderContent: (m: ImMessage) => ReactNode;
}) {
  const onLeft = !sender.isSelf;
  return (
    <div
      className={cn(
        "flex items-end gap-2 px-1",
        onLeft ? "justify-start" : "justify-end",
        meta.showHeader ? "mt-2" : "mt-0.5",
      )}
    >
      {onLeft &&
        (meta.showHeader ? (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-(--shell-accent) text-[12px] font-semibold text-white">
            {sender.initial}
          </div>
        ) : (
          <div className="w-7 shrink-0" />
        ))}
      <div
        className={cn(
          "flex max-w-[68%] min-w-0 flex-col",
          onLeft ? "items-start" : "items-end",
        )}
      >
        {meta.showHeader && (
          <div className="mb-0.5 flex items-baseline gap-1.5 px-1 text-[11px] text-muted-foreground">
            {onLeft && (
              <span className="font-semibold text-foreground">
                {sender.displayName}
              </span>
            )}
            <span>{formatTime(m.createdAt)}</span>
          </div>
        )}
        <div
          className={cn(
            "min-w-0 whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed",
            onLeft ? "bg-muted text-foreground" : "bg-[#16a34a] text-white",
          )}
        >
          {renderContent(m)}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3:桶导出** — 新建 `packages/web-common/src/im/index.ts`:

```ts
export {
  ImMessageList,
  type ImMessageListProps,
  type ImMessageListLabels,
  type ImMessageSender,
} from "./im-message-list";
export {
  annotateRows,
  dayLabel,
  formatTime,
  type MessageRowMeta,
} from "./message-rows";
```

- [ ] **Step 4:`./im` 导出** — 在 `packages/web-common/package.json` 的 `exports` 里、`"./shell"` 之后加:

```json
    "./im": {
      "types": "./src/im/index.ts",
      "default": "./src/im/index.ts"
    }
```

- [ ] **Step 5:web-common typecheck**

Run:`pnpm --filter @meshbot/web-common typecheck`
Expected:PASS(ImMessage 类型来自 `@meshbot/types`——web-common 已依赖;`cn`/`lucide-react` 已在 P3a 加)。

- [ ] **Step 6:确认 apps 未动 + 提交**

Run:`git status -s`(应只 `packages/web-common/*`)。
```bash
git add packages/web-common
git commit -m "feat(web-common): 新增 ./im 统一 IM 消息列表(variant 行式/气泡 + 注入)

message-rows(annotateRows 参数化 groupKey / formatTime / dayLabel)+ ImMessageList
(variant rows|bubbles,resolveSender/renderContent/labels/onCopy 注入)。两 app 暂不动,下两 task 切换。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2:web-agent 改用共享 ImMessageList(variant rows)

**Files:**
- Modify: `apps/web-agent/src/components/im/im-conversation-body.tsx`
- Modify: `apps/web-agent/src/app/globals.css`
- Delete: `apps/web-agent/src/components/im/im-message-list.tsx`;`apps/web-agent/src/lib/message-rows.ts`(仅当无其它消费者)

- [ ] **Step 1:Tailwind @source** — 在 `apps/web-agent/src/app/globals.css` 已有的两条 `@source` 之后加:

```css
@source "../../../../packages/web-common/src/im";
```

- [ ] **Step 2:im-conversation-body 换用共享组件**

先读 `apps/web-agent/src/components/im/im-conversation-body.tsx`,看它当前如何渲染 `<ImMessageList messages members currentUserId />`(拿到 `members`/`currentUserId`/`t`)。把:
- import 从 `@/components/im/im-message-list` 改为 `import { ImMessageList } from "@meshbot/web-common/im";`
- `MarkdownContent` 保留本地 import(`@/components/session/markdown-content`)。
- 渲染处改为(用注入 prop 复刻原行为):

```tsx
<ImMessageList
  messages={messages}
  variant="rows"
  groupKey={(m) => m.senderId}
  resolveSender={(m) => {
    const dn = members[m.senderId]?.displayName ?? m.senderId;
    return {
      displayName: dn,
      initial: dn.charAt(0).toUpperCase(),
      isSelf: m.senderId === currentUserId,
    };
  }}
  renderContent={(m) => <MarkdownContent text={m.content} />}
  labels={{ today: t("today"), yesterday: t("yesterday"), copy: t("copy") }}
  onCopy={(m) => void navigator.clipboard?.writeText(m.content)}
/>
```

(`t` 来自该文件已有的 `useTranslations("messages")`;`members`/`currentUserId` 沿用它现有的取值。若该文件本身不持 `members`/`currentUserId` 而是透传给旧 ImMessageList,则在此文件按原样取到再传——读文件确认。)

- [ ] **Step 3:删本地 im-message-list;判 message-rows 是否可删**

```bash
git rm apps/web-agent/src/components/im/im-message-list.tsx
grep -rn "lib/message-rows\|annotateRows" apps/web-agent/src | grep -v "components/im/im-message-list.tsx"
```
若上面 grep **无输出**(除已删文件),则 `git rm apps/web-agent/src/lib/message-rows.ts`(annotateRows 已进共享);若还有别的消费者,**保留** `lib/message-rows.ts`。

- [ ] **Step 4:typecheck + build**

Run:`pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`(timeout 600000)。Expected:PASS。

- [ ] **Step 5:视觉冒烟(人工)** — `pnpm dev:web-agent`,进 IM 频道/私聊会话:消息行式渲染、分组(连续同人仅首条显头像+名)、日期分隔、markdown、hover 复制,均与改前**一致**。

- [ ] **Step 6:提交**

```bash
git add -A
git commit -m "refactor(web-agent): IM 消息列表改用 @meshbot/web-common/im(variant rows)

im-conversation-body 用共享 ImMessageList(rows,注入 MarkdownContent/members/copy);
删本地 im-message-list + message-rows(annotateRows 已进共享);globals.css 加 @source。零回归。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3:web-main 改用共享 ImMessageList(variant bubbles)

**Files:**
- Modify: `apps/web-main/src/components/im/im-conversation.tsx`
- Modify: `apps/web-main/src/app/globals.css`
- Delete: `apps/web-main/src/components/im/im-message-list.tsx`(含内联 annotateRows)

- [ ] **Step 1:Tailwind @source** — 在 `apps/web-main/src/app/globals.css` 已有的 `@source "../../../../packages/design/src";` 之后加:

```css
@source "../../../../packages/web-common/src/im";
```

- [ ] **Step 2:im-conversation 换用共享组件**

先读 `apps/web-main/src/components/im/im-conversation.tsx`,看它当前如何渲染 `<ImMessageList messages agentName />`(拿到 `agentName`/`t`)。把:
- import 从 `@/components/im/im-message-list` 改为 `import { ImMessageList } from "@meshbot/web-common/im";`
- 渲染处改为:

```tsx
<ImMessageList
  messages={messages}
  variant="bubbles"
  groupKey={(m) => m.senderType}
  resolveSender={(m) => ({
    displayName: agentName,
    initial: agentName.trim().charAt(0).toUpperCase() || "A",
    isSelf: m.senderType !== "agent",
  })}
  renderContent={(m) => m.content}
  labels={{ today: t("today"), yesterday: t("yesterday") }}
/>
```

(`t` 来自该文件的 `useTranslations("imConversation")`;`agentName` 沿用现有取值。不传 `onCopy`——气泡态原本就无复制条。)

- [ ] **Step 3:删本地 im-message-list**

```bash
git rm apps/web-main/src/components/im/im-message-list.tsx
grep -rn "components/im/im-message-list\|annotateRows" apps/web-main/src | grep -v "已删"
```
Expected:无残留引用(web-main 的 annotateRows 是内联在该文件里的,随文件删除)。

- [ ] **Step 4:typecheck + build**

Run:`pnpm --filter @meshbot/web-main typecheck && pnpm --filter @meshbot/web-main build`(timeout 600000)。Expected:PASS。

- [ ] **Step 5:视觉冒烟(人工)** — `pnpm dev:web-main`(3002),进 Agent-DM 会话:气泡渲染(agent 左灰泡带头像/名、user 右绿泡)、分组、日期分隔,均与改前**一致**。

- [ ] **Step 6:提交**

```bash
git add -A
git commit -m "refactor(web-main): IM 消息列表改用 @meshbot/web-common/im(variant bubbles)

im-conversation 用共享 ImMessageList(bubbles,注入 agentName/纯文本);删本地 im-message-list
+ 其内联 annotateRows(已进共享);globals.css 加 @source。两端 IM 消息列表统一,消重复。零回归。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾
- [ ] **Step 1:全量围栏** — `pnpm typecheck && pnpm check`;Expected 全绿。
- [ ] **Step 2:两端冒烟对比** — web-agent(3001)行式 + web-main(3002)气泡,消息渲染均与改前一致;确认 `@meshbot/web-common/im` 被两端消费(`grep -rln "@meshbot/web-common/im" apps | wc -l` 应为 2)。

---

## Self-Review
**1. 覆盖**:建共享 `./im`(helpers + 统一组件)✅;web-agent rows ✅;web-main bubbles ✅;消两端重复(含内联 annotateRows)✅;MarkdownContent 注入不搬 ✅;两端 @source ✅。
**2. 占位符**:共享组件全码给出;app 侧渲染 prop 给出;Step 2 让实现者"先读文件确认 members/currentUserId/agentName 取值"——因这些在各自 body 里怎么持有需现读,不臆造。
**3. 一致**:`ImMessageList`/`resolveSender`/`renderContent`/`groupKey`/`labels` 在共享定义与两端调用一致;web-agent `m=>m.senderId`+isSelf=(senderId===currentUserId);web-main `m=>m.senderType`+isSelf=(senderType!=="agent")+onLeft=!isSelf 复刻"agent 左 user 右"。
**4. 风险**:web-main 是云端已部署,Task3 动它的消息渲染——收尾强制 web-main 冒烟;两端 transpilePackages 已含 web-common(已确认);@source 漏加=class 静默丢(Step1 + 冒烟兜底)。

## 关于 P3c+(后续)
P3c B 类注入(page-shell/session-header/message-list、im-conversation-header/body 的展示部分);P3d C 类 adapter 契约(rail/sidebar/dock);P4 web-main 用上整套壳;P5 登录前。各自成 plan。
