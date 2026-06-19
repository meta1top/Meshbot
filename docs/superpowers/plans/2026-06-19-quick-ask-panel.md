# 消息壳重构 · Plan 4：随手问 shell 级全局面板 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 顶栏 `✦` 全局开关一个 shell 级右侧面板「随手问」——在任意页面右侧浮出、不绑定当前对话；首条消息惰性创建一个 `kind="quick"` 的临时 Agent 会话（不进侧栏），「保存到助手」把它提升为侧栏会话。

**Architecture:** 后端复用现有 Session 基础设施：`kind` 列已是 `varchar`、`listAllSorted()` 已按 `kind="user"` 过滤——故新增第三种值 `kind="quick"` **无需任何 DB 迁移**（quick 会话被现有过滤自动排除在侧栏外）；新增 `listQuickSessions()`（历史）+ `promoteToSidebar()`（保存=kind quick→user）。前端：顶栏 `✦` 切换全局 atom；`AppShellLayout` 据此把面板渲染为 workspace 行右侧的**独立圆角卡**（与内容卡之间留同宽深色缝，即 Plan 1 的 inset 卡语言）；面板复用 `useSessionStream` + 共享 `ChatInput`，首条惰性 `createSession(kind="quick")`。

**Tech Stack:** NestJS + TypeORM(SQLite，better-sqlite3) + Jest（server-agent service spec）；Next.js + Jotai + socket.io；next-intl。

## Global Constraints

- 目标：`apps/server-agent`（后端）+ `apps/web-agent`（前端）+ `libs/types-agent`（共享 schema）。不改云端轨（server-main）。
- **无 DB 迁移**：`kind` 已是 varchar 无 CHECK 约束；新增值 `"quick"` 只是数据，不动 schema。实体 TS 类型 `kind` 扩为 `"user" | "quick" | "im"`（仅 TS）。
- server-agent 规范：Session 唯一归属 `SessionService`（`check:repo`）；`SessionService` 经 `ScopedRepository`（账号作用域）；单表写无需 `@Transactional`（`check:tx`）；私有 `@Transactional` 方法命名 `*InDb/*InTx/persist*`（`check:naming`，本计划新方法均单表、公开，不涉及）。Controller 瘦身（业务下沉 Service）。Swagger 完整声明（`swagger-api-declaration`）。
- 共享 schema 放 `libs/types-agent`（`shared-data-model`）；`libs/types-*` 禁依赖 NestJS/TypeORM。后端 `createZodDto`。
- i18n：可见串走 next-intl，新增 key 同时改 `messages/zh.json`+`en.json`，遵循扁平 stub 工作流；`missing=0,asymmetric=0`。无裸字符串。
- 配色沿用 `--shell-*`；面板=深色画布上独立圆角卡（视觉对照 `.superpowers/brainstorm/90418-1781852822/content/04e-inset-cards.html`）。
- 提交中文 conventional commits，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 每个 Task 后：后端 Task 跑 `pnpm test`（相关 spec）+ `pnpm typecheck` + 相关 `pnpm check:*`；前端 Task 跑 `pnpm --filter @meshbot/web-agent typecheck` + `pnpm lint`。

---

### Task 1: 后端 SessionService — quick 会话支持（service + schema + 测试）

`createSession` 支持 `kind`；新增 `listQuickSessions()` 与 `promoteToSidebar()`；实体 `kind` 类型扩展；`CreateSessionSchema` 加可选 `kind`。**无迁移**。

**Files:**
- Modify: `apps/server-agent/src/entities/session.entity.ts`（kind 类型）
- Modify: `libs/types-agent/src/session.ts`（CreateSessionSchema 加 kind）
- Modify: `apps/server-agent/src/services/session.service.ts`（createSession 透传 kind；listQuickSessions；promoteToSidebar）
- Modify: `apps/server-agent/src/services/session.service.spec.ts`（新方法测试）

**Interfaces:**
- Produces:
  - `createSession(input: CreateSessionInput): Promise<{sessionId; session: SessionSummary}>`（`input.kind?: "user"|"quick"`，默认 "user"）
  - `listQuickSessions(): Promise<SessionSummary[]>`（kind="quick"，按 updatedAt desc）
  - `promoteToSidebar(sessionId: string): Promise<SessionSummary>`（kind quick→user）
- Consumes: 现有 `toSummary`、`ScopedRepository<Session>`、`listAllSorted` 的查询风格。

- [ ] **Step 1: 实体 kind 类型扩展**

`session.entity.ts` 的 kind 列类型从 `"user" | "im"` 改为 `"user" | "quick" | "im"`：

```ts
  @Column({ type: "varchar", default: "user" })
  kind!: "user" | "quick" | "im";
```

（仅 TS 类型；DB 不变。）

- [ ] **Step 2: CreateSessionSchema 加可选 kind**

`libs/types-agent/src/session.ts` 的 `CreateSessionSchema`（现 `{content: z.string().min(1)}`）加：

```ts
export const CreateSessionSchema = z.object({
  content: z.string().min(1),
  /** "quick" = 随手问临时会话（不进侧栏）；缺省 "user"。 */
  kind: z.enum(["user", "quick"]).optional(),
});
```

- [ ] **Step 3: 写失败测试（先读现有 spec 的 harness）**

先读 `apps/server-agent/src/services/session.service.spec.ts` 头部，沿用其构造 `SessionService` 的方式（DataSource / repo / ScopedRepository fake）。新增 describe：

```ts
describe("quick sessions", () => {
  it("createSession(kind='quick') 建的会话不出现在 listAllSorted()", async () => {
    await service.createSession({ content: "临时问题", kind: "quick" });
    const list = await service.listAllSorted();
    expect(list).toHaveLength(0);
  });

  it("listQuickSessions() 只返回 quick 会话", async () => {
    await service.createSession({ content: "正常", kind: "user" });
    const { sessionId } = await service.createSession({ content: "随手", kind: "quick" });
    const quick = await service.listQuickSessions();
    expect(quick.map((s) => s.id)).toEqual([sessionId]);
  });

  it("promoteToSidebar() 把 quick 提升为 user，进入 listAllSorted、移出 listQuickSessions", async () => {
    const { sessionId } = await service.createSession({ content: "随手", kind: "quick" });
    const summary = await service.promoteToSidebar(sessionId);
    expect(summary.id).toBe(sessionId);
    expect((await service.listAllSorted()).map((s) => s.id)).toContain(sessionId);
    expect(await service.listQuickSessions()).toHaveLength(0);
  });
});
```

> 若现有 spec 的 harness 难以直接复用（如需真 better-sqlite3 内存库），按其既有模式照搭；以现有 `session.service.spec.ts` 的 setup 为准。

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm test -- session.service`
Expected: FAIL（新方法未实现 / kind 未透传）。

- [ ] **Step 5: 实现**

`session.service.ts`：

(a) `createSession` 建会话时透传 kind（找到现 89-109 行 create Session 处，把写死的 kind 改为 `input.kind ?? "user"`）：

```ts
    const session = this.sessionRepo.create({
      // ...现有字段...
      kind: input.kind ?? "user",
    });
```

（若现有 create 未显式写 kind（走默认 "user"），则显式补 `kind: input.kind ?? "user"`。）

(b) 新增两个方法（紧邻 `listAllSorted` 之后，复用其 query 风格 + `toSummary`）：

```ts
  /** 列出随手问临时会话（kind="quick"），按更新时间倒序——供随手问面板「历史」。 */
  async listQuickSessions(): Promise<SessionSummary[]> {
    const rows = await this.sessionRepo
      .createQueryBuilder("s")
      .where("s.kind = :kind", { kind: "quick" })
      .orderBy("s.updated_at", "DESC")
      .getMany();
    return rows.map(toSummary);
  }

  /** 把随手问临时会话沉淀为侧栏会话（kind: quick→user）。 */
  async promoteToSidebar(sessionId: string): Promise<SessionSummary> {
    await this.sessionRepo.update({ id: sessionId, kind: "quick" }, { kind: "user" });
    const s = await this.findSessionOrFail(sessionId);
    return toSummary(s);
  }
```

> `findSessionOrFail` 用现有同名/等价私有方法（spec 探查里 deleteSession/patch 用到的「按 id 取或抛」）；若名字不同，沿用现有取单条方法。`createQueryBuilder("s")` 经 ScopedRepository 仍受 cloud_user_id 约束（与 listAllSorted 一致）。

- [ ] **Step 6: 跑测试确认通过 + typecheck**

Run: `pnpm test -- session.service`
Expected: PASS（含新 3 用例）。
Run: `pnpm typecheck`
Expected: 通过（实体 kind 联合扩展、CreateSessionInput 含 kind）。

- [ ] **Step 7: 静态围栏 + 提交**

Run: `pnpm check:repo && pnpm check:tx && pnpm check:naming`
Expected: 无新增 finding（新方法单表读/写、公开、不需 @Transactional）。

```bash
git add apps/server-agent/src/entities/session.entity.ts libs/types-agent/src/session.ts apps/server-agent/src/services/session.service.ts apps/server-agent/src/services/session.service.spec.ts
git commit -m "feat(server-agent): Session 支持 kind=quick（随手问临时会话）+ 历史/沉淀

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 后端 SessionController — quick 端点

`POST /api/sessions` 透传 kind；新增 `GET /api/sessions/quick`（历史）与 `POST /api/sessions/:id/promote`（沉淀）。

**Files:**
- Modify: `apps/server-agent/src/controllers/session.controller.ts`
- Modify: `libs/types-agent/src/session.ts`（若需 `SessionListResponse` 复用于 quick；`SessionSummary` 出参已有）

**Interfaces:**
- Consumes: Task 1 的 `listQuickSessions` / `promoteToSidebar` / `createSession(input.kind)`。
- Produces: REST `GET /api/sessions/quick → {sessions: SessionSummary[]}`；`POST /api/sessions/:id/promote → SessionSummary`；`POST /api/sessions` body 增 `kind?`。

- [ ] **Step 1: create 透传 kind**

`session.controller.ts` 的 `create(@Body() dto: CreateSessionDto)`：把 `dto.kind` 透传给 `sessions.createSession({content: dto.content, kind: dto.kind})`（`CreateSessionDto` 已由 Task 1 的 schema 扩展自动带上 kind）。

- [ ] **Step 2: 新增 quick 列表端点**

复用现有 `list()` 的形态（返回 `SessionListResponse = {sessions}`）：

```ts
  @Get("quick")
  @ApiOperation({ summary: "列出随手问临时会话（历史）" })
  @ApiOkResponse({ type: SessionListResponseDto })
  async listQuick(): Promise<SessionListResponse> {
    return { sessions: await this.sessions.listQuickSessions() };
  }
```

> 路由顺序：`@Get("quick")` 必须在任何 `@Get(":id")` 之前声明，避免 "quick" 被当作 :id。本控制器现有 GET 是 `@Get()`（list）与 `@Get(":id/history")` —— 把 `@Get("quick")` 放在 `list()` 附近、确认无 `@Get(":id")` 裸段冲突。

- [ ] **Step 3: 新增 promote 端点**

```ts
  @Post(":id/promote")
  @ApiOperation({ summary: "把随手问会话沉淀为侧栏会话" })
  @ApiOkResponse({ type: SessionSummaryDto })
  async promote(@Param("id") id: string): Promise<SessionSummary> {
    return this.sessions.promoteToSidebar(id);
  }
```

> `SessionSummaryDto` / `SessionListResponseDto`：用现有的（list 端点已声明 `SessionListResponse` 的 DTO；patch 端点返回 `SessionSummary` 已有对应 DTO）。复用，勿重复定义。

- [ ] **Step 4: typecheck + swagger 围栏 + 提交**

Run: `pnpm typecheck && pnpm --filter @meshbot/server-agent... typecheck` （以根 typecheck 为准）
Run: `pnpm check:repo`（controller 不得注入 repo——本任务只调 service，OK）
Expected: 通过。

```bash
git add apps/server-agent/src/controllers/session.controller.ts libs/types-agent/src/session.ts
git commit -m "feat(server-agent): 新增 /api/sessions/quick 与 /:id/promote 端点

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 前端 rest + atoms

`@/rest/session` 加 quick 相关调用；新增随手问面板的全局 atom。

**Files:**
- Modify: `apps/web-agent/src/rest/session.ts`
- Create: `apps/web-agent/src/atoms/assistant-panel.ts`

**Interfaces:**
- Produces:
  - `createSession(content: string, kind?: "user" | "quick"): Promise<CreateSessionResponse>`（扩展现有）
  - `fetchQuickSessions(): Promise<SessionSummary[]>`
  - `promoteSession(id: string): Promise<SessionSummary>`
  - `assistantPanelOpenAtom`（`atom<boolean>(false)`）、`currentQuickSessionIdAtom`（`atom<string | null>(null)`）
- Consumes: `apiClient`，`SessionSummary`/`CreateSessionResponse`（@meshbot/types-agent）。

- [ ] **Step 1: 扩展 rest/session.ts**

现有 `createSession(content)` 改为带可选 kind，并加两个函数：

```ts
export async function createSession(
  content: string,
  kind?: "user" | "quick",
): Promise<CreateSessionResponse> {
  const { data } = await apiClient.post<CreateSessionResponse>("/api/sessions", { content, kind });
  return data;
}

export async function fetchQuickSessions(): Promise<SessionSummary[]> {
  const { data } = await apiClient.get<{ sessions: SessionSummary[] }>("/api/sessions/quick");
  return data.sessions;
}

export async function promoteSession(id: string): Promise<SessionSummary> {
  const { data } = await apiClient.post<SessionSummary>(`/api/sessions/${id}/promote`, {});
  return data;
}
```

> 现有 `createSession` 的调用方（assistant/page、new-message-view）传单参——可选 kind 不破坏它们（默认 user）。

- [ ] **Step 2: 新增 atoms**

`apps/web-agent/src/atoms/assistant-panel.ts`：

```ts
import { atom } from "jotai";

/** 顶栏 ✦ 控制的随手问面板开关（全局）。 */
export const assistantPanelOpenAtom = atom(false);

/** 面板当前随手问会话 id；null = 尚未开始（首条消息惰性创建）。 */
export const currentQuickSessionIdAtom = atom<string | null>(null);
```

- [ ] **Step 3: typecheck + lint + 提交**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`

```bash
git add apps/web-agent/src/rest/session.ts apps/web-agent/src/atoms/assistant-panel.ts
git commit -m "feat(web-agent): 随手问 rest（quick/promote）+ 面板开关 atom

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 顶栏 ✦ 开关 + AppShellLayout shell 级 dock

顶栏加 `✦` 切换 `assistantPanelOpenAtom`；`AppShellLayout` 据此把面板渲染为 workspace 行右侧的独立圆角卡（与内容卡之间留深色缝）。

**Files:**
- Modify: `apps/web-agent/src/components/shell/shell-top-bar.tsx`
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`
- Modify: `apps/web-agent/messages/zh.json`、`en.json`（✦ 提示）

**Interfaces:**
- Consumes: `assistantPanelOpenAtom`（Task 3）；`AssistantDock`（Task 5，本任务先用占位/前向引用，见下）。

- [ ] **Step 1: i18n**

`zh.json` `appShell` 命名空间加 `"assistant": "随手问"`（en: `"Assistant"`）。（用于 ✦ 按钮 title/aria-label。）保持 `missing=0,asymmetric=0`（必要时补扁平 stub）。

- [ ] **Step 2: 顶栏 ✦ 按钮**

`shell-top-bar.tsx`：在帮助按钮（HelpCircle）左侧加一个 ✦ 按钮，切换 `assistantPanelOpenAtom`，open 时高亮。引入 `useAtom`（jotai）+ `Sparkles`（lucide）+ `useTranslations("appShell")`。在搜索框 `</div>` 之后、帮助按钮之前插入：

```tsx
      <button
        type="button"
        data-no-drag
        onClick={() => setPanelOpen((v) => !v)}
        title={tShell("assistant")}
        aria-label={tShell("assistant")}
        aria-pressed={panelOpen}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
          panelOpen
            ? "bg-(--shell-accent)/20 text-(--shell-accent)"
            : "text-white/65 hover:bg-white/10 hover:text-white",
        )}
      >
        <Sparkles className="h-4 w-4" />
      </button>
```

顶部加 `import { cn } from "@meshbot/design"`、`import { useAtom } from "jotai"`、`import { assistantPanelOpenAtom } from "@/atoms/assistant-panel"`、`Sparkles` 入 lucide import；组件内 `const [panelOpen, setPanelOpen] = useAtom(assistantPanelOpenAtom); const tShell = useTranslations("appShell");`。

- [ ] **Step 3: AppShellLayout 加 shell 级 dock**

`app-shell-layout.tsx`：读 `assistantPanelOpenAtom`；在 workspace 行（`<div className="flex min-h-0 flex-1 pr-1.5 pb-1.5">`）内、内容 `<section>` **之后**，作为同级第三块加随手问卡（独立圆角 + 左侧 `ml-1.5` 深色缝）：

在文件顶部 import：`import { useAtomValue } from "jotai"`、`import { assistantPanelOpenAtom } from "@/atoms/assistant-panel"`、`import { AssistantDock } from "@/components/im/assistant-dock"`。组件内：`const panelOpen = useAtomValue(assistantPanelOpenAtom);`。

在内容 `</section>` 之后、外层 `</div>` 之前插入：

```tsx
          {panelOpen && (
            <aside className="ml-1.5 hidden w-[340px] shrink-0 overflow-hidden rounded-(--shell-radius) bg-(--shell-content) xl:flex">
              <AssistantDock />
            </aside>
          )}
```

> `ml-1.5` = 与内容卡之间的深色缝（同 `pr-1.5`/`pb-1.5` 宽度）；`rounded-(--shell-radius)` 全圆角 = 独立卡；`xl:flex` 与原 rightPanel 断点一致（窄屏不挤）。内容 `<section>` 保持现有 `rounded-r-(--shell-radius)` 不变（侧栏+内容仍是融合卡，随手问是右侧另一张卡）。

- [ ] **Step 4: typecheck + lint + 视觉**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`
（AssistantDock 由 Task 5 创建；本任务依赖它——故 Task 4 与 Task 5 可由同一实施者连续完成，或 Task 5 先于 Task 4 的 typecheck。实施顺序见下「实施顺序」。）

- [ ] **Step 5: 提交**（与 Task 5 一起，见实施顺序）

---

### Task 5: AssistantDock 面板组件

随手问面板：品牌渐变头（✦ 随手问 + 🕘历史/＋新对话/×关闭）+ 复用 `useSessionStream` 的对话区 + 共享 `ChatInput` + 「保存到助手」。

**Files:**
- Create: `apps/web-agent/src/components/im/assistant-dock.tsx`
- Modify: `apps/web-agent/messages/zh.json`、`en.json`（面板文案）

**Interfaces:**
- Consumes: `useSessionStream(sessionId|null, scrollRef)`（`{messages,running,send,interrupt,...}`）；`MessageList`（`@/components/session/message-list`，渲染 TimelineMessage）；`ChatInput`；`createSession(content,"quick")`/`fetchQuickSessions`/`promoteSession`（Task 3）；`addSessionAtom`（沉淀后进侧栏）；`assistantPanelOpenAtom`/`currentQuickSessionIdAtom`（Task 3）。
- Produces: `export function AssistantDock(): JSX.Element;`

- [ ] **Step 1: i18n（`assistantDock` 命名空间）**

`zh.json`：
```json
"assistantDock": {
  "title": "随手问",
  "subtitle": "全局助手 · 不绑定当前对话",
  "history": "历史",
  "newChat": "新对话",
  "close": "关闭",
  "save": "保存到助手",
  "saved": "已保存到助手",
  "placeholder": "继续问，或问点别的…",
  "emptyHint": "随手问点什么——不绑定当前对话。"
}
```
`en.json`：
```json
"assistantDock": {
  "title": "Quick Ask",
  "subtitle": "Global assistant · not tied to this conversation",
  "history": "History",
  "newChat": "New chat",
  "close": "Close",
  "save": "Save to Assistant",
  "saved": "Saved to Assistant",
  "placeholder": "Ask anything…",
  "emptyHint": "Ask the assistant anything — not tied to this conversation."
}
```
保持对称；必要时补扁平 stub。

- [ ] **Step 2: 写 AssistantDock**

`apps/web-agent/src/components/im/assistant-dock.tsx`：

```tsx
"use client";

import { useSetAtom } from "jotai";
import { Clock, Plus, Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { assistantPanelOpenAtom, currentQuickSessionIdAtom } from "@/atoms/assistant-panel";
import { addSessionAtom } from "@/atoms/sessions";
import { ChatInput } from "@/components/common/chat-input";
import { MessageList } from "@/components/session/message-list";
import { useSessionStream } from "@/hooks/use-session-stream";
import { useAtom } from "jotai";
import { createSession, fetchQuickSessions, promoteSession } from "@/rest/session";
import type { SessionSummary } from "@meshbot/types-agent";

export function AssistantDock() {
  const t = useTranslations("assistantDock");
  const setOpen = useSetAtom(assistantPanelOpenAtom);
  const [sessionId, setSessionId] = useAtom(currentQuickSessionIdAtom);
  const addSession = useSetAtom(addSessionAtom);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stream = useSessionStream(sessionId, scrollRef);
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [saved, setSaved] = useState(false);

  // 首条惰性创建 quick 会话；之后走 stream.send
  const handleSend = useCallback(
    async (body: string) => {
      if (!sessionId) {
        const res = await createSession(body, "quick");
        setSessionId(res.sessionId);
        return;
      }
      await stream.send(body);
    },
    [sessionId, stream, setSessionId],
  );

  const handleNew = useCallback(() => {
    setSessionId(null);
    setDraft("");
    setSaved(false);
    setHistoryOpen(false);
  }, [setSessionId]);

  const handleHistory = useCallback(async () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) setHistory(await fetchQuickSessions());
  }, [historyOpen]);

  const handleSave = useCallback(async () => {
    if (!sessionId) return;
    const summary = await promoteSession(sessionId);
    addSession(summary);
    setSaved(true);
  }, [sessionId, addSession]);

  return (
    <div className="flex h-full w-full flex-col">
      {/* 品牌渐变头 */}
      <div className="flex h-[50px] shrink-0 items-center gap-2 border-b border-border bg-[linear-gradient(120deg,#fff3ea,#ffe7ef_45%,#eef2ff)] px-3.5 dark:bg-none">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-(--shell-accent) text-white">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <div className="flex-1">
          <div className="text-[14px] font-bold text-foreground">{t("title")}</div>
          <div className="text-[10.5px] text-muted-foreground">{t("subtitle")}</div>
        </div>
        <button type="button" onClick={() => void handleHistory()} title={t("history")} aria-label={t("history")} className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground">
          <Clock className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={handleNew} title={t("newChat")} aria-label={t("newChat")} className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground">
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => setOpen(false)} title={t("close")} aria-label={t("close")} className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 历史下拉 */}
      {historyOpen && (
        <div className="max-h-[240px] overflow-y-auto border-b border-border p-1.5">
          {history.length === 0 ? (
            <div className="px-2 py-2 text-[12px] text-muted-foreground">{t("emptyHint")}</div>
          ) : (
            history.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => { setSessionId(s.id); setHistoryOpen(false); setSaved(false); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-muted"
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0 opacity-60" />
                <span className="truncate">{s.title}</span>
              </button>
            ))
          )}
        </div>
      )}

      {/* 对话区 */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        {sessionId ? (
          <>
            <MessageList messages={stream.messages} sessionId={sessionId} running={stream.running} onRegenerateOptimisticCut={() => {}} />
            {!saved && (
              <button
                type="button"
                onClick={() => void handleSave()}
                className="mt-2 self-start rounded-md border border-(--shell-accent)/40 bg-(--shell-accent)/10 px-2.5 py-1 text-[11.5px] font-medium text-(--shell-accent) hover:bg-(--shell-accent)/15"
              >
                💾 {t("save")}
              </button>
            )}
            {saved && <div className="mt-2 self-start text-[11.5px] text-muted-foreground">✓ {t("saved")}</div>}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-[12.5px] text-muted-foreground">
            {t("emptyHint")}
          </div>
        )}
      </div>

      {/* 输入 */}
      <div className="border-t border-border p-2.5">
        <ChatInput value={draft} onChange={setDraft} onSend={handleSend} onInterrupt={stream.interrupt} isLoading={stream.running} placeholder={t("placeholder")} />
      </div>
    </div>
  );
}
```

> 复用要点：`useSessionStream(sessionId, scrollRef)` 在 sessionId=null 时惰性 inert；首条 `handleSend` 走 `createSession(body,"quick")` 设 sessionId（stream 随即激活、加载并流式渲染）；之后走 `stream.send`。`MessageList` 复用会话渲染（markdown/工具调用/流式）。「保存到助手」`promoteSession` + `addSession` 让其进侧栏「助手」段。`onRegenerateOptimisticCut` 在面板内传 no-op（重生成是会话页能力，面板从简）。

- [ ] **Step 3: typecheck + lint（Task 4+5 合并验证）**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm lint`
Expected: 通过（AssistantDock 存在后 AppShellLayout 引用解析）。核对 `MessageList` 的 props（`messages/sessionId/running/onRegenerateOptimisticCut`，`usageByMessage?` 可省）与 `ChatInput`/`useSessionStream` 签名一致。

- [ ] **Step 4: 视觉/交互确认**

`pnpm dev:web-agent`：任意页面点顶栏 `✦` → 右侧浮出随手问独立圆角卡（与内容卡间有深色缝），左侧内容仍可见可用；输入首条 → 流式回答；`＋` 新对话清空；`🕘` 历史列出过往 quick 会话可切回；「保存到助手」后该会话出现在左栏「助手」段；`×` 关闭。对照 mockup `04e-inset-cards.html`。

- [ ] **Step 5: 提交（Task 4 + Task 5 合并提交）**

```bash
git add apps/web-agent/src/components/shell/shell-top-bar.tsx apps/web-agent/src/components/layouts/app-shell-layout.tsx apps/web-agent/src/components/im/assistant-dock.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): 随手问 shell 级全局面板（顶栏 ✦ + 右侧独立卡 + 保存沉淀）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 实施顺序与依赖

Task 1 → Task 2（后端，独立可测）→ Task 3（前端 rest/atoms）→ **Task 4 + Task 5 合并实施**（互相引用：AppShellLayout 引 AssistantDock，AssistantDock 引 atoms/rest；同一实施者连续完成、一次 typecheck、一次提交）。

## 非本计划范围

- quick 会话的过期清理 / 数量上限（暂不做；历史可无限增长，后续可加 TTL）。
- 面板宽度可拖拽、窄屏（<xl）下的抽屉式呈现（暂用 `xl:flex`，与原 rightPanel 断点一致）。
- 「保存到助手」后面板是否自动切到该会话的视觉细化（暂显「已保存」）。

## Self-Review（对照 spec + 决策）

- **覆盖**：spec 需求 2（顶栏 ✦ → shell 级随手问面板，不绑定当前对话）→ Task 4/5；「随手问 + 沉淀会话」双层 → kind=quick（Task 1）+ promoteToSidebar/保存（Task 1/2/5）；默认行为（✦ 开/＋ 新/历史/不进侧栏直到保存）→ Task 5；shell 级 inset 卡 → Task 4 dock。
- **无迁移正确性**：kind 是无约束 varchar，listAllSorted 已过滤 kind="user" → quick 自动排除侧栏，无需 DDL。已在 Task 1 测试覆盖（quick 不入 listAllSorted；promote 后入）。
- **占位符扫描**：无 TBD；`onRegenerateOptimisticCut` no-op、历史无 TTL、xl 断点均为显式简化并说明。
- **类型一致**：`kind: "user"|"quick"|"im"`（实体）与 `CreateSessionSchema.kind: "user"|"quick"`（创建入参，im 不可由前端建）一致；`createSession(content,kind?)`/`fetchQuickSessions`/`promoteSession` 前后端签名一致；`useSessionStream`/`MessageList`/`ChatInput` 复用签名取自实证。
- **围栏**：新 service 方法单表、公开 → 不触发 check:tx/naming；controller 只调 service → check:repo OK；schema 在 libs/types-agent 不依赖 Nest/TypeORM。
- **风险**：路由 `@Get("quick")` 须先于任何 `@Get(":id")`（Step 2 已注明）；首条惰性创建后 stream 激活的时序依赖 useSessionStream 对 sessionId 变化的订阅（与 /session 页一致）。
