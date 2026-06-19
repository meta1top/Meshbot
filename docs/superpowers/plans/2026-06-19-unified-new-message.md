# 消息壳重构 · Plan 3：统一「新消息」(`/messages/new`) 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `/messages/new` 视图：一个「至：」收件人选择 + 富文本正文，一次发起对应会话并跳转到会话详情；同时闭合 Plan 1 遗留的 `✎ → /messages/new` 404。

**Architecture:** 纯前端（`apps/web-agent`）。复用现成原语：`createDm(userId)` / `createSession(content)` / IM socket `emit(IM_WS_EVENTS.send,{conversationId,content})` / 孤儿组件 `ChannelPicker`（创建频道）。「至：」下拉按三组：频道（现有 + 「创建新频道…」）/ 成员（org 成员 → 私信）/ 助手（「开启新助手会话」）。选定可消息收件人后启用 Plan 2 的富文本 `ChatInput` 写正文；发送时按收件人类型创建/解析会话→发出正文→跳转。正文语义统一为「所发起会话的首条消息」。

**Tech Stack:** Next.js App Router、React 19、Jotai、@tanstack/react-query（`useMembers`）、socket.io（IM）、next-intl；纯逻辑用根 Jest（`*.test.ts`，node env）TDD。

## Global Constraints

- 目标包：仅 `apps/web-agent`，不改后端 / `libs/*`。
- 复用接口签名（均已存在）：
  - `createDm(userId: string): Promise<ConversationSummary>`（`@/rest/im`，已存在或新建则返回）
  - `createSession(content: string): Promise<{sessionId: string; session: SessionSummary}>`（`@/rest/session`）
  - IM 发送：`getImSocket().emit(IM_WS_EVENTS.send, { conversationId, content })`（`@/lib/im-socket` + `@meshbot/types`），无乐观插入
  - `upsertConversationAtom`（`@/atoms/im`），`addSessionAtom`（`@/atoms/sessions`）
  - `useMembers(orgId)`（`@/rest/org`）→ `MemberInfo[] {userId,email,displayName,role}`；`orgId = currentUser?.org?.id ?? null`
  - `ChannelPicker`（`@/components/im/channel-picker`，props `{open,onClose,onNavigate:(conversationId:string)=>void}`，内部已 upsert+创建）
  - `ChatInput`（`@/components/common/chat-input`，Plan 2 富文本；props `{value,onChange,onSend,placeholder}`）
- 导航：频道/私信 `router.push("/messages?id="+id)`；助手 `router.push("/session?id="+sessionId)`。
- i18n：可见串走 next-intl，新增 key 同时改 `messages/zh.json` + `en.json`；遵循仓库扁平 stub 工作流；`missing=0, asymmetric=0` 必须保持。无裸字符串。
- 配色沿用 `--shell-*`；视觉对照 mockup `.superpowers/brainstorm/90418-1781852822/content/03-new-message.html`。
- 提交信息中文 conventional commits，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 每个 Task 后 `pnpm --filter @meshbot/web-agent typecheck` + `pnpm lint` 必须过。

---

### Task 1: 收件人过滤/分组纯函数 + TDD

把「至：」搜索的过滤/分组逻辑抽成纯函数（频道按 name，成员按 displayName/email，成员排除自己，空查询返回全部）。

**Files:**
- Create: `apps/web-agent/src/lib/recipient-filter.ts`
- Create: `apps/web-agent/src/lib/recipient-filter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RecipientGroups { channels: ConversationSummary[]; members: MemberInfo[]; }
  export function filterRecipients(query: string, channels: ConversationSummary[], members: MemberInfo[], currentUserId: string | null): RecipientGroups;
  ```
- Consumes: `ConversationSummary`（`@meshbot/types`，type-only），`MemberInfo`（`@meshbot/types-agent`，type-only）。

- [ ] **Step 1: 写失败测试**

`apps/web-agent/src/lib/recipient-filter.test.ts`：

```ts
import { filterRecipients } from "./recipient-filter";

const ch = (id: string, name: string) =>
  ({ id, type: "channel", visibility: "public", name, peer: null, unreadCount: 0, lastMessage: null }) as never;
const mem = (userId: string, displayName: string, email: string) =>
  ({ userId, displayName, email, role: "member" }) as never;

describe("filterRecipients", () => {
  const channels = [ch("c1", "综合"), ch("c2", "产品讨论")];
  const members = [mem("u1", "Test03", "t3@x.com"), mem("me", "我", "me@x.com")];

  it("空查询返回全部频道，成员排除自己", () => {
    const r = filterRecipients("", channels, members, "me");
    expect(r.channels).toHaveLength(2);
    expect(r.members.map((m) => m.userId)).toEqual(["u1"]);
  });

  it("按频道名过滤（大小写不敏感）", () => {
    const r = filterRecipients("产品", channels, members, "me");
    expect(r.channels.map((c) => c.id)).toEqual(["c2"]);
  });

  it("按成员 displayName / email 过滤", () => {
    expect(filterRecipients("test03", channels, members, "me").members.map((m) => m.userId)).toEqual(["u1"]);
    expect(filterRecipients("t3@x", channels, members, "me").members.map((m) => m.userId)).toEqual(["u1"]);
  });

  it("currentUserId 为 null 时不排除任何成员", () => {
    expect(filterRecipients("", channels, members, null).members).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- recipient-filter`
Expected: FAIL（module not found）。

- [ ] **Step 3: 写实现**

`apps/web-agent/src/lib/recipient-filter.ts`：

```ts
import type { ConversationSummary } from "@meshbot/types";
import type { MemberInfo } from "@meshbot/types-agent";

export interface RecipientGroups {
  channels: ConversationSummary[];
  members: MemberInfo[];
}

/** 过滤「至：」候选：频道按 name，成员按 displayName/email；成员始终排除当前用户。空查询返回全部。 */
export function filterRecipients(
  query: string,
  channels: ConversationSummary[],
  members: MemberInfo[],
  currentUserId: string | null,
): RecipientGroups {
  const q = query.trim().toLowerCase();
  const others = members.filter((m) => m.userId !== currentUserId);
  if (!q) return { channels, members: others };
  return {
    channels: channels.filter((c) => (c.name ?? "").toLowerCase().includes(q)),
    members: others.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q),
    ),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- recipient-filter`
Expected: PASS（4 用例绿）。

- [ ] **Step 5: typecheck + lint + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`

```bash
git add apps/web-agent/src/lib/recipient-filter.ts apps/web-agent/src/lib/recipient-filter.test.ts
git commit -m "feat(web-agent): 新增「至：」收件人过滤纯函数（含单测）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: NewMessageView + `/messages/new` 路由 + i18n

构建新消息视图：「至：」搜索/分组下拉 + 收件人 chip + 富文本正文 + 发送（按类型创建/解析会话→发首条→跳转）；「创建新频道」复用 `ChannelPicker`。

**Files:**
- Create: `apps/web-agent/src/components/im/new-message-view.tsx`
- Create: `apps/web-agent/src/app/messages/new/page.tsx`
- Modify: `apps/web-agent/messages/zh.json`、`apps/web-agent/messages/en.json`

**Interfaces:**
- Consumes: Task 1 `filterRecipients`；Global Constraints 列出的所有原语。
- Produces: `export function NewMessageView(): JSX.Element;`（默认 export 的 page 包裹它）。

- [ ] **Step 1: 加 i18n key（`newMessage` 命名空间）**

`zh.json` 顶层加：

```json
"newMessage": {
  "title": "新消息",
  "toLabel": "至：",
  "toPlaceholder": "#频道、@某人 或 ✦ 助手",
  "groupChannels": "频道",
  "groupMembers": "成员",
  "groupAssistant": "助手",
  "createChannel": "创建新频道…",
  "startSession": "开启新助手会话",
  "bodyPlaceholder": "写条消息…",
  "empty": "选好上面的「至：」对象，下面写好内容，一次发出。"
}
```

`en.json` 同步：

```json
"newMessage": {
  "title": "New message",
  "toLabel": "To:",
  "toPlaceholder": "#channel, @someone, or ✦ assistant",
  "groupChannels": "Channels",
  "groupMembers": "People",
  "groupAssistant": "Assistant",
  "createChannel": "Create new channel…",
  "startSession": "Start a new assistant chat",
  "bodyPlaceholder": "Write a message…",
  "empty": "Pick a recipient above, write your message below, and send."
}
```

若 `sync:locales --check` 报 MISSING，按仓库扁平 stub 做法在两文件根补对应空 stub。保持 `missing=0, asymmetric=0`。

- [ ] **Step 2: 写 NewMessageView**

`apps/web-agent/src/components/im/new-message-view.tsx`：

```tsx
"use client";

import { IM_WS_EVENTS } from "@meshbot/types";
import { useAtomValue, useSetAtom } from "jotai";
import { Hash, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { currentUserAtom } from "@/atoms/auth";
import { conversationsAtom, upsertConversationAtom } from "@/atoms/im";
import { addSessionAtom } from "@/atoms/sessions";
import { ChannelPicker } from "@/components/im/channel-picker";
import { ChatInput } from "@/components/common/chat-input";
import { getImSocket } from "@/lib/im-socket";
import { filterRecipients } from "@/lib/recipient-filter";
import { createDm } from "@/rest/im";
import { useMembers } from "@/rest/org";
import { createSession } from "@/rest/session";

type Recipient =
  | { kind: "channel"; id: string; label: string }
  | { kind: "member"; userId: string; label: string }
  | { kind: "session" };

export function NewMessageView() {
  const t = useTranslations("newMessage");
  const router = useRouter();
  const currentUser = useAtomValue(currentUserAtom);
  const conversations = useAtomValue(conversationsAtom);
  const upsertConversation = useSetAtom(upsertConversationAtom);
  const addSession = useSetAtom(addSessionAtom);

  const orgId = currentUser?.org?.id ?? null;
  const { data: members = [] } = useMembers(orgId);

  const [query, setQuery] = useState("");
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const channels = useMemo(
    () => conversations.filter((c) => c.type === "channel"),
    [conversations],
  );
  const groups = useMemo(
    () => filterRecipients(query, channels, members, currentUser?.id ?? null),
    [query, channels, members, currentUser?.id],
  );

  const recipientLabel =
    recipient?.kind === "session" ? t("startSession") : recipient?.label;

  const handleSend = async (body: string) => {
    if (!recipient) return;
    if (recipient.kind === "session") {
      const res = await createSession(body);
      addSession(res.session);
      router.push(`/session?id=${res.sessionId}`);
      return;
    }
    if (recipient.kind === "channel") {
      getImSocket().emit(IM_WS_EVENTS.send, {
        conversationId: recipient.id,
        content: body,
      });
      router.push(`/messages?id=${recipient.id}`);
      return;
    }
    const conv = await createDm(recipient.userId);
    upsertConversation(conv);
    getImSocket().emit(IM_WS_EVENTS.send, {
      conversationId: conv.id,
      content: body,
    });
    router.push(`/messages?id=${conv.id}`);
  };

  return (
    <div className="flex w-full flex-1 flex-col">
      <div className="mb-3 text-[15px] font-bold text-foreground">{t("title")}</div>

      {/* 至： */}
      <div className="relative mb-4 flex items-center gap-2 border-b border-border pb-3">
        <span className="text-[13px] font-semibold text-muted-foreground">{t("toLabel")}</span>
        {recipient ? (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-(--shell-accent)/15 px-2 py-1 text-[13px] font-medium text-(--shell-accent)">
            {recipientLabel}
            <button type="button" onClick={() => setRecipient(null)} aria-label={t("toLabel")}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ) : (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("toPlaceholder")}
            className="flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        )}

        {!recipient && (
          <div className="absolute left-0 top-full z-20 mt-1 max-h-[360px] w-full max-w-[520px] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg">
            <div className="px-2.5 pt-2 pb-1 text-[11px] font-bold text-muted-foreground">{t("groupChannels")}</div>
            {groups.channels.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setRecipient({ kind: "channel", id: c.id, label: c.name ?? "" })}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] hover:bg-muted"
              >
                <Hash className="h-4 w-4 shrink-0 opacity-70" />
                <span className="truncate">{c.name}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-(--shell-accent) hover:bg-muted"
            >
              <span className="w-4 text-center">＋</span>
              {t("createChannel")}
            </button>

            <div className="px-2.5 pt-3 pb-1 text-[11px] font-bold text-muted-foreground">{t("groupMembers")}</div>
            {groups.members.map((m) => (
              <button
                key={m.userId}
                type="button"
                onClick={() => setRecipient({ kind: "member", userId: m.userId, label: m.displayName })}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] hover:bg-muted"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-(--shell-accent) text-[10px] font-semibold text-white">
                  {m.displayName.charAt(0).toUpperCase()}
                </span>
                <span className="truncate">{m.displayName}</span>
              </button>
            ))}

            <div className="px-2.5 pt-3 pb-1 text-[11px] font-bold text-muted-foreground">{t("groupAssistant")}</div>
            <button
              type="button"
              onClick={() => setRecipient({ kind: "session" })}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-(--shell-accent) hover:bg-muted"
            >
              <Sparkles className="h-4 w-4 shrink-0" />
              {t("startSession")}
            </button>
          </div>
        )}
      </div>

      {/* 正文：选定收件人后启用 */}
      {recipient ? (
        <div className="mt-auto">
          <ChatInput value={draft} onChange={setDraft} onSend={handleSend} placeholder={t("bodyPlaceholder")} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
          {t("empty")}
        </div>
      )}

      <ChannelPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onNavigate={(id) => router.push(`/messages?id=${id}`)}
      />
    </div>
  );
}
```

> 说明：「创建新频道」走 `ChannelPicker` 对话框（含名称/可见性/成员），其内部已 `createChannel`+`upsert`+`onNavigate`，本视图不重复；该路径不携带正文（频道创建是配置流，正文仅用于「频道/成员/助手」三类可消息收件人）。

- [ ] **Step 3: 写路由 page**

`apps/web-agent/src/app/messages/new/page.tsx`：

```tsx
"use client";

import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { NewMessageView } from "@/components/im/new-message-view";

export default function NewMessagePage() {
  return (
    <AppShellLayout>
      <NewMessageView />
    </AppShellLayout>
  );
}
```

> 无 `useSearchParams`，无需 Suspense。`areaFromPath("/messages/new")` 已归 `messages` 区（`startsWith("/messages")`），侧栏自动渲染 `MessagesSidebar`。

- [ ] **Step 4: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`
Expected: 通过。确认 `ChatInput`/`ChannelPicker`/`createDm`/`createSession`/`getImSocket`/`IM_WS_EVENTS`/`useMembers` 导入路径正确，`ConversationSummary.peer`/`name` 等字段使用正确。

- [ ] **Step 5: 交互确认**

`pnpm dev:web-agent`：点侧栏头部 `✎` → 进入 `/messages/new`（不再 404）。①「至：」输入过滤频道/成员；②选频道→写正文→发送→消息出现在该频道且跳转；③选成员→发送→创建/打开 DM 跳转并发出；④「开启新助手会话」→写正文→发送→新会话 `/session?id=`；⑤「创建新频道…」→弹 ChannelPicker→创建后跳转。对照 mockup `03-new-message.html`。

- [ ] **Step 6: 提交**

```bash
git add apps/web-agent/src/components/im/new-message-view.tsx apps/web-agent/src/app/messages/new/page.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): 统一「新消息」视图（至：分组 + 富文本正文，一处发起会话）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 非本计划范围 / 有意简化

- 助手分组只提供「开启新助手会话」（正文即首条 `createSession`）；继续已有助手会话从侧栏「助手」段进入（不在新消息列出），避免引入 session 发送管线复杂度。
- 「创建新频道」走 ChannelPicker 配置对话框，不携带正文（配置流）。
- 「至：」下拉用聚焦即展开 + 点击选择；多收件人、键盘上下键导航、@/# 前缀解析等留作后续增强。
- 随手问 shell 面板、对话区精修——各自后续计划。

## Self-Review（对照 spec + 决策）

- **覆盖**：spec 需求 5（一处发起频道/私信/助手）→ Task 2 三类发送路径；闭合 Plan 1 的 `✎→/messages/new` 404 → Task 2 路由。用户决策「选至 + 富文本写正文 + 发起 + 跳转」→ handleSend 三分支（session=createSession 首条；channel=emit send；member=createDm+emit send）均创建/解析后发首条并跳转。
- **占位符扫描**：无 TBD；「创建新频道不携带正文」「助手仅开新会话」为显式简化并已说明。
- **类型一致**：`RecipientGroups`/`filterRecipients`（Task 1）在 Task 2 调用签名一致；`Recipient` 判别联合的三 kind 与 handleSend 三分支一致；复用原语签名全部取自探查实证。
- **风险**：IM 发送无乐观插入（与现有 messages/page 行为一致，socket 回灌后在目标会话页显示）；`createDm` 已处理「已存在则复用」；下拉用 `bg-popover`/`border-border`（design 既有 token）。i18n 扁平 stub 按既有工作流。
