# 会话标题自动生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建会话后异步用 LLM 生成更友好的标题，通过 socket 实时推送给前端 sidebar，不影响主对话流式且不覆盖用户手动改名。

**Architecture:** sessions 表加 `title_generated` 标记位；新 `SessionTitleService` 在 `SessionController.create` 内 fire-and-forget 入队、调 LLM、写库（条件 update 防 race）、emit ws 事件；gateway 把事件 namespace 广播；前端 AppShell 订阅 + `updateSessionTitleAtom` 局部 patch sessions atom。

**Tech Stack:** NestJS（`@Transactional` 不需要；单表条件 update）、TypeORM SQLite migration、Zod（types-agent）、Jotai atom、socket.io、Jest（better-sqlite3 in-memory）。

---

## 文件结构

**Spec ref：** `docs/superpowers/specs/2026-05-24-session-title-generation-design.md`

### 后端（新建 / 修改）

| 路径 | 责任 |
|---|---|
| `apps/server-agent/src/entities/session.entity.ts`（改） | 加 `titleGenerated: boolean` 列 |
| `apps/server-agent/src/migrations/1779500000000-AddSessionsTitleGenerated.ts`（新） | `ALTER TABLE` 加列 |
| `libs/types-agent/src/session.ts`（改） | SessionSummary 加 titleGenerated；新增 SessionTitleUpdatedEventSchema + SESSION_WS_EVENTS.titleUpdated |
| `apps/server-agent/src/services/session.service.ts`（改） | toSummary 带 titleGenerated；patch({title}) 同步 mark titleGenerated=true；新 `patchIfNotGenerated` |
| `apps/server-agent/src/services/session-title.service.ts`（新） | schedule + generate + sanitizeTitle 全套 |
| `libs/agent/src/graph/graph.service.ts`（改） | 暴露 `getModel()` 复用 cached chat model |
| `apps/server-agent/src/session.module.ts`（改） | 注册 SessionTitleService |
| `apps/server-agent/src/controllers/session.controller.ts`（改） | create 后 schedule title |
| `apps/server-agent/src/ws/session.gateway.ts`（改） | 加 onTitleUpdated @OnEvent → server.emit broadcast |

### 前端（修改）

| 路径 | 责任 |
|---|---|
| `apps/web-agent/src/atoms/sessions.ts`（改） | 加 updateSessionTitleAtom |
| `apps/web-agent/src/components/layouts/app-shell-layout.tsx`（改） | 订阅 SESSION_WS_EVENTS.titleUpdated |

---

## Task 1：Session entity 加 titleGenerated + migration

**Files:**
- Modify: `apps/server-agent/src/entities/session.entity.ts`
- Create: `apps/server-agent/src/migrations/1779500000000-AddSessionsTitleGenerated.ts`

- [ ] **Step 1：改 entity**

在 `Session` 类内 `pinnedAt` 列之后、`createdAt` 之前插入：

```ts
/**
 * 是否「有过明确标题」：LLM 自动生成成功 或 用户手动改过。
 * 用一个字段同时挡住两件事：title 生成任务避免覆盖用户改名 + 未来「重生成
 * 标题」入口判断是否已生成。createSession 默认 false。
 */
@Column({ name: "title_generated", default: false })
titleGenerated!: boolean;
```

（参考 `model-config.entity.ts` 里 `enabled` 列的写法 —— TypeORM better-sqlite3 driver 自动把 boolean 映射到 INTEGER 0/1。）

- [ ] **Step 2：写 migration**

新建 `apps/server-agent/src/migrations/1779500000000-AddSessionsTitleGenerated.ts`：

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * sessions 表加 title_generated 标记位。值义：title 是 LLM 生成或用户改过。
 * 用 INTEGER 0/1 存储（SQLite 没原生 boolean，TypeORM 用 INTEGER 映射）。
 */
export class AddSessionsTitleGenerated1779500000000
  implements MigrationInterface
{
  name = "AddSessionsTitleGenerated1779500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "title_generated" INTEGER NOT NULL DEFAULT 0`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 DROP COLUMN；保留列即可（参考 AddSessionsPinnedAt 的 down 注释）
  }
}
```

- [ ] **Step 3：typecheck**

```bash
pnpm --filter @meshbot/server-agent typecheck
```

Expected：exit 0。

- [ ] **Step 4：commit**

```bash
git add apps/server-agent/src/entities/session.entity.ts \
        apps/server-agent/src/migrations/1779500000000-AddSessionsTitleGenerated.ts
git commit -m "$(cat <<'EOF'
feat(session): sessions 加 title_generated 标记位

为后续 SessionTitleService 提供「title 是否已被明确设定」语义，挡住
异步 LLM 生成 vs 用户改名的 race，也为未来「重生成标题」菜单提供判断。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2：types-agent 加字段 + 事件 schema

**Files:**
- Modify: `libs/types-agent/src/session.ts`
- Modify: `libs/types-agent/src/session.spec.ts`

- [ ] **Step 1：写失败测试**

在 `libs/types-agent/src/session.spec.ts` 末尾追加：

```ts
import { SessionTitleUpdatedEventSchema } from "./session";

describe("session schemas — title generation", () => {
  it("SessionSummarySchema 含 titleGenerated 字段", () => {
    const ok = SessionSummarySchema.parse({
      id: "s1",
      title: "hi",
      status: "idle",
      pinned: false,
      pinnedAt: null,
      titleGenerated: true,
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    });
    expect(ok.titleGenerated).toBe(true);
  });

  it("SessionSummarySchema 缺 titleGenerated 直接 reject", () => {
    expect(() =>
      SessionSummarySchema.parse({
        id: "s1",
        title: "hi",
        status: "idle",
        pinned: false,
        pinnedAt: null,
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("SessionTitleUpdatedEventSchema 必传 sessionId + title", () => {
    const ok = SessionTitleUpdatedEventSchema.parse({
      sessionId: "s1",
      title: "Title",
    });
    expect(ok).toEqual({ sessionId: "s1", title: "Title" });
    expect(() =>
      SessionTitleUpdatedEventSchema.parse({ sessionId: "s1" }),
    ).toThrow();
  });

  it("SESSION_WS_EVENTS.titleUpdated 常量存在", () => {
    expect(SESSION_WS_EVENTS.titleUpdated).toBe("session.title_updated");
  });
});
```

- [ ] **Step 2：跑测试看失败**

```bash
pnpm jest libs/types-agent/src/session.spec.ts 2>&1 | tail -15
```

Expected：3 个新 case fail（缺 titleGenerated 字段 / 缺 SessionTitleUpdatedEventSchema 导出 / SESSION_WS_EVENTS.titleUpdated undefined）。

- [ ] **Step 3：实现**

`libs/types-agent/src/session.ts` 修改 `SessionSummarySchema`：

```ts
/** 侧边栏 + 创会话接口共用的会话概要。 */
export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: SessionStatus,
  /** 派生：pinnedAt != null。客户端用做语义判断，避免每处都比较 pinnedAt。 */
  pinned: z.boolean(),
  /** ISO datetime；非 null 即已固定，值用于客户端排序与未来重排。 */
  pinnedAt: z.string().datetime().nullable(),
  /**
   * 是否「有过明确标题」：LLM 自动生成成功 或 用户手动改过。
   * false = title 仍是创会话时的「首条前 30 字」fallback。
   */
  titleGenerated: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
```

在文件末尾（SESSION_WS_EVENTS 之前）追加事件 schema：

```ts
/**
 * socket: session.title_updated —— SessionTitleService 后台 LLM 生成完成。
 * Gateway namespace 广播；前端 sidebar / sessions atom 局部更新 title。
 */
export const SessionTitleUpdatedEventSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
});
export type SessionTitleUpdatedEvent = z.infer<
  typeof SessionTitleUpdatedEventSchema
>;
```

修改 `SESSION_WS_EVENTS`（**保持现有 key 顺序、在 interrupt 之后追加**）：

```ts
export const SESSION_WS_EVENTS = {
  subscribe: "session.subscribe",
  unsubscribe: "session.unsubscribe",
  interrupt: "session.interrupt",
  titleUpdated: "session.title_updated",
  runHuman: "run.human",
  // ... 其他保持不变
} as const;
```

- [ ] **Step 4：跑测试看通过**

```bash
pnpm jest libs/types-agent/src/session.spec.ts 2>&1 | tail -10
```

Expected：全部 PASS。

- [ ] **Step 5：commit**

```bash
git add libs/types-agent/src/session.ts libs/types-agent/src/session.spec.ts
git commit -m "$(cat <<'EOF'
feat(types-agent): SessionSummary.titleGenerated + SessionTitleUpdatedEvent

为 SessionTitleService 后台生成 + ws 推送提供 schema。SESSION_WS_EVENTS
新增 titleUpdated 常量 = "session.title_updated"。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

注意：旧的 SessionSummarySchema 测试 fixture（Task 2 of sidebar plan 写的几条）会因为缺 titleGenerated 而 fail —— **下一 Task 修复**。

---

## Task 3：补旧 SessionSummary 测试 fixture

**Files:**
- Modify: `libs/types-agent/src/session.spec.ts`

- [ ] **Step 1：定位破掉的旧 case**

```bash
pnpm jest libs/types-agent/src/session.spec.ts 2>&1 | tail -40
```

Expected：旧测试 case `SessionSummarySchema 通过基本字段` / `CreateSessionResponseSchema 同时带 sessionId 和 session` 因为 fixture 缺 `titleGenerated` 而 fail。

- [ ] **Step 2：补字段**

把 `session.spec.ts` 里所有形如 `{ id: "s1", title: ..., status: ..., pinned: ..., pinnedAt: ..., createdAt: ..., updatedAt: ... }` 的 SessionSummary fixture 都加 `titleGenerated: false`（或 true，按 case 语义选）。

具体改两处：

```ts
// describe("session schemas — sidebar list") 块的:
// it("SessionSummarySchema 通过基本字段", ...)
const ok = SessionSummarySchema.parse({
  id: "s1",
  title: "hi",
  status: "idle",
  pinned: false,
  pinnedAt: null,
  titleGenerated: false,  // 新增
  createdAt: "2026-05-24T00:00:00.000Z",
  updatedAt: "2026-05-24T00:00:00.000Z",
});
```

```ts
// it("CreateSessionResponseSchema 同时带 sessionId 和 session", ...)
const r = CreateSessionResponseSchema.parse({
  sessionId: "s1",
  session: {
    id: "s1",
    title: "hi",
    status: "running",
    pinned: false,
    pinnedAt: null,
    titleGenerated: false,  // 新增
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  },
});
```

- [ ] **Step 3：跑测试**

```bash
pnpm jest libs/types-agent/src/session.spec.ts 2>&1 | tail -10
```

Expected：全部 PASS。

- [ ] **Step 4：commit**

```bash
git add libs/types-agent/src/session.spec.ts
git commit -m "$(cat <<'EOF'
test(types-agent): 旧 SessionSummary fixture 补 titleGenerated 字段

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4：SessionService.patchIfNotGenerated + patch 改动

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`
- Modify: `apps/server-agent/src/services/session.service.spec.ts`

- [ ] **Step 1：写失败测试**

`session.service.spec.ts` 末尾追加：

```ts
describe("patch / patchIfNotGenerated — title generation", () => {
  it("patch({ title }) 同步 mark titleGenerated=true", async () => {
    const { sessionId } = await service.createSession({ content: "old" });
    const before = await service.findSessionOrFail(sessionId);
    expect(before.titleGenerated).toBe(false);
    const after = await service.patch(sessionId, { title: "new title" });
    expect(after.title).toBe("new title");
    expect(after.titleGenerated).toBe(true);
  });

  it("patch({ pinned }) 不改 titleGenerated", async () => {
    const { sessionId } = await service.createSession({ content: "x" });
    const r = await service.patch(sessionId, { pinned: true });
    expect(r.titleGenerated).toBe(false);
  });

  it("patchIfNotGenerated：titleGenerated=false 时生效，返 SessionSummary + mark true", async () => {
    const { sessionId } = await service.createSession({ content: "x" });
    const r = await service.patchIfNotGenerated(sessionId, "LLM 生成");
    expect(r).not.toBeNull();
    expect(r?.title).toBe("LLM 生成");
    expect(r?.titleGenerated).toBe(true);
  });

  it("patchIfNotGenerated：titleGenerated=true 时返 null，不改数据", async () => {
    const { sessionId } = await service.createSession({ content: "x" });
    await service.patch(sessionId, { title: "user 改的" });
    const r = await service.patchIfNotGenerated(sessionId, "LLM 想覆盖");
    expect(r).toBeNull();
    const s = await service.findSessionOrFail(sessionId);
    expect(s.title).toBe("user 改的");
  });
});
```

- [ ] **Step 2：跑测试看失败**

```bash
pnpm jest apps/server-agent/src/services/session.service.spec.ts 2>&1 | tail -15
```

Expected：
- 「patch({ title }) 同步 mark titleGenerated=true」fail（title 改了，但 titleGenerated 仍 false）
- 「patchIfNotGenerated」两个 case fail（方法不存在）

- [ ] **Step 3：实现 patch 改动 + patchIfNotGenerated**

修改 `apps/server-agent/src/services/session.service.ts` 的 `patch`：

```ts
async patch(
  sessionId: string,
  input: { title?: string; pinned?: boolean },
): Promise<SessionSummary> {
  const changes: Partial<Session> = {};
  if (input.title !== undefined) {
    changes.title = input.title;
    changes.titleGenerated = true;
  }
  if (input.pinned !== undefined) {
    changes.pinnedAt = input.pinned ? new Date() : null;
  }
  await this.sessionRepo.update({ id: sessionId }, changes);
  const s = await this.findSessionOrFail(sessionId);
  return toSummary(s);
}
```

在 `patch` 后追加新方法：

```ts
/**
 * 仅在 titleGenerated 仍为 false 时把 title 写入并 mark generated=true。
 * 用户已手动改名时返回 null，调用方丢弃结果。单 update + WHERE 三件套
 * 保证原子，无需事务。
 *
 * 给 SessionTitleService 用 —— 防止 LLM 生成期间用户改名被覆盖。
 */
async patchIfNotGenerated(
  sessionId: string,
  title: string,
): Promise<SessionSummary | null> {
  const res = await this.sessionRepo.update(
    { id: sessionId, titleGenerated: false },
    { title, titleGenerated: true },
  );
  if (!res.affected) return null;
  const s = await this.findSessionOrFail(sessionId);
  return toSummary(s);
}
```

修改 `toSummary` helper（文件顶部）使 SessionSummary 带 titleGenerated：

```ts
function toSummary(s: Session): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    pinned: s.pinnedAt !== null,
    pinnedAt: s.pinnedAt ? s.pinnedAt.toISOString() : null,
    titleGenerated: s.titleGenerated,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
```

- [ ] **Step 4：跑测试看通过**

```bash
pnpm jest apps/server-agent/src/services/session.service.spec.ts 2>&1 | tail -10
```

Expected：全部 PASS（含旧 case 与 4 个新 case）。注意旧的 `createSession 返 SessionSummary` 测试可能因 toSummary 新字段而 fail，加 `expect(r.session.titleGenerated).toBe(false);` 即可。

- [ ] **Step 5：fences**

```bash
pnpm check:tx && pnpm check:naming && pnpm check:lock-tx && pnpm check:repo
```

Expected：全部 0 finding。

- [ ] **Step 6：commit**

```bash
git add apps/server-agent/src/services/session.service.ts \
        apps/server-agent/src/services/session.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(session): patch({title}) 同步 mark titleGenerated=true + patchIfNotGenerated

patch({title}) 用户改名时把 titleGenerated 一起设 true，挡住后续 LLM 自动
生成覆盖。patchIfNotGenerated 是给 SessionTitleService 用的条件 update：
仅在 titleGenerated=false 时写入并 mark true，否则返 null 让调用方丢弃。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5：GraphService 暴露 getModel

**Files:**
- Modify: `libs/agent/src/graph/graph.service.ts`

- [ ] **Step 1：加方法**

`libs/agent/src/graph/graph.service.ts` 内 `resolveModel`（约 line 156）之后追加：

```ts
/**
 * 暴露给 SessionTitleService 等非 graph 流程使用同一 chat model（带 cache）。
 * 共享 modelCache 避免 SessionTitleService 每次都 initChatModel（~200ms）。
 */
async getModel(): Promise<BaseChatModel> {
  return this.resolveModel();
}
```

- [ ] **Step 2：typecheck**

```bash
pnpm --filter @meshbot/agent typecheck
```

Expected：exit 0。

- [ ] **Step 3：commit**

```bash
git add libs/agent/src/graph/graph.service.ts
git commit -m "$(cat <<'EOF'
feat(graph): GraphService 暴露 getModel 复用 cached chat model

供 SessionTitleService 等非 graph 流程共享 modelCache，避免重复
initChatModel（~200ms / 次）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6：SessionTitleService

**Files:**
- Create: `apps/server-agent/src/services/session-title.service.ts`
- Create: `apps/server-agent/src/services/session-title.service.spec.ts`
- Modify: `apps/server-agent/src/session.module.ts`

- [ ] **Step 1：写失败测试**

新建 `apps/server-agent/src/services/session-title.service.spec.ts`：

```ts
import { type SessionSummary, SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SessionTitleService } from "./session-title.service";

/** 收集 emit 事件的 EventEmitter2 wrapper。 */
function spyEmitter() {
  const events: { name: string; payload: unknown }[] = [];
  const emitter = new EventEmitter2();
  emitter.onAny((name, payload) =>
    events.push({ name: String(name), payload }),
  );
  return { emitter, events };
}

/** 内存版 SessionService 替身（仅实现 SessionTitleService 用到的 3 个方法）。 */
function fakeSessionService(initialTitleGenerated = false) {
  const summary: SessionSummary = {
    id: "s1",
    title: "old",
    status: "idle",
    pinned: false,
    pinnedAt: null,
    titleGenerated: initialTitleGenerated,
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
  return {
    summary,
    async findSessionOrFail() {
      return summary;
    },
    async patchIfNotGenerated(_id: string, title: string) {
      if (summary.titleGenerated) return null;
      summary.title = title;
      summary.titleGenerated = true;
      return { ...summary };
    },
  };
}

/** 假 PromptService —— 仅 getPrompt。 */
function fakePromptService(content?: string) {
  return {
    getPrompt(_name: string) {
      return content;
    },
  };
}

/** 假 GraphService —— 仅 getModel，返一个 invoke 假 model。 */
function fakeGraph(content: string) {
  return {
    async getModel() {
      return {
        async invoke(_prompt: string) {
          return { content };
        },
      };
    },
  };
}

function fakeGraphError(err: Error) {
  return {
    async getModel() {
      return {
        async invoke(_prompt: string) {
          throw err;
        },
      };
    },
  };
}

/** 等所有 fire-and-forget setImmediate 跑完。 */
async function flushPromises(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("SessionTitleService", () => {
  it("LLM 返清晰 title → patchIfNotGenerated + emit titleUpdated", async () => {
    const sess = fakeSessionService();
    const { emitter, events } = spyEmitter();
    const svc = new SessionTitleService(
      fakeGraph("会话标题") as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    svc.schedule("s1", "first user content");
    await flushPromises();
    expect(sess.summary.title).toBe("会话标题");
    expect(sess.summary.titleGenerated).toBe(true);
    expect(events.map((e) => e.name)).toContain(SESSION_WS_EVENTS.titleUpdated);
    const evt = events.find((e) => e.name === SESSION_WS_EVENTS.titleUpdated);
    expect(evt?.payload).toEqual({ sessionId: "s1", title: "会话标题" });
  });

  it("LLM 返空白 → 不写库 + 不 emit", async () => {
    const sess = fakeSessionService();
    const { emitter, events } = spyEmitter();
    const svc = new SessionTitleService(
      fakeGraph("   \n  ") as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    svc.schedule("s1", "content");
    await flushPromises();
    expect(sess.summary.title).toBe("old");
    expect(sess.summary.titleGenerated).toBe(false);
    expect(events.find((e) => e.name === SESSION_WS_EVENTS.titleUpdated)).toBeUndefined();
  });

  it("LLM 返带引号 → sanitize 后写库", async () => {
    const sess = fakeSessionService();
    const { emitter } = spyEmitter();
    const svc = new SessionTitleService(
      fakeGraph('"quoted title"') as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    svc.schedule("s1", "content");
    await flushPromises();
    expect(sess.summary.title).toBe("quoted title");
  });

  it("LLM 返 > 30 字 → 硬截断", async () => {
    const sess = fakeSessionService();
    const { emitter } = spyEmitter();
    const long = "a".repeat(50);
    const svc = new SessionTitleService(
      fakeGraph(long) as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    svc.schedule("s1", "content");
    await flushPromises();
    expect(sess.summary.title.length).toBe(30);
  });

  it("入口 titleGenerated 已 true → 不调 LLM", async () => {
    const sess = fakeSessionService(true);
    const { emitter, events } = spyEmitter();
    let invoked = false;
    const svc = new SessionTitleService(
      {
        async getModel() {
          return {
            async invoke() {
              invoked = true;
              return { content: "shouldn't run" };
            },
          };
        },
      } as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    svc.schedule("s1", "content");
    await flushPromises();
    expect(invoked).toBe(false);
    expect(sess.summary.title).toBe("old");
    expect(events.find((e) => e.name === SESSION_WS_EVENTS.titleUpdated)).toBeUndefined();
  });

  it("LLM 抛错 → schedule 不抛、不 emit", async () => {
    const sess = fakeSessionService();
    const { emitter, events } = spyEmitter();
    const svc = new SessionTitleService(
      fakeGraphError(new Error("network")) as never,
      sess as never,
      fakePromptService() as never,
      emitter,
    );
    expect(() => svc.schedule("s1", "content")).not.toThrow();
    await flushPromises();
    expect(sess.summary.title).toBe("old");
    expect(events.find((e) => e.name === SESSION_WS_EVENTS.titleUpdated)).toBeUndefined();
  });

  it("PromptService 返 prompt → buildPrompt 用模板替换 {{content}}", async () => {
    const sess = fakeSessionService();
    const { emitter } = spyEmitter();
    let capturedPrompt = "";
    const svc = new SessionTitleService(
      {
        async getModel() {
          return {
            async invoke(prompt: string) {
              capturedPrompt = prompt;
              return { content: "T" };
            },
          };
        },
      } as never,
      sess as never,
      fakePromptService("Title: {{content}}") as never,
      emitter,
    );
    svc.schedule("s1", "USER MSG");
    await flushPromises();
    expect(capturedPrompt).toBe("Title: USER MSG");
  });
});
```

- [ ] **Step 2：跑测试看失败**

```bash
pnpm jest apps/server-agent/src/services/session-title.service.spec.ts 2>&1 | tail -10
```

Expected：cannot find module `./session-title.service`。

- [ ] **Step 3：实现 service**

新建 `apps/server-agent/src/services/session-title.service.ts`：

```ts
import { GraphService, PromptService } from "@meshbot/agent";
import {
  type SessionTitleUpdatedEvent,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SessionService } from "./session.service";

const TITLE_MAX = 30;

/** Prompt 模板未定义时的 fallback —— 让 dev 环境不依赖 prompt 文件铺设。 */
const FALLBACK_PROMPT =
  "You are a chat title generator. Given the first user message of a " +
  "conversation, write a concise 5–15 character (CJK or English) title " +
  "summarizing the topic.\n\n" +
  "Rules:\n" +
  "- Output ONLY the title text; no quotes, no punctuation, no prefix.\n" +
  "- Use the same language as the user message.\n" +
  "- No emoji unless the user message itself is mostly emoji.\n\n" +
  "User message:\n{{content}}";

/**
 * 会话标题自动生成服务 —— SessionController.create 后 fire-and-forget。
 *
 * 流程：findSession 看 titleGenerated → 调 LLM → sanitize → patchIfNotGenerated
 * 条件 update → emit ws 事件 → gateway 广播 → 前端 sidebar atom 局部 patch。
 *
 * 失败 / race 处理：开始前 short-circuit；patchIfNotGenerated 原子条件防
 * race；LLM 异常 catch 仅 log；返空 / 全空白不写库。
 */
@Injectable()
export class SessionTitleService {
  private readonly logger = new Logger(SessionTitleService.name);

  constructor(
    private readonly graph: GraphService,
    private readonly sessions: SessionService,
    private readonly prompt: PromptService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** fire-and-forget 入队；setImmediate 让 controller 立即返回。 */
  schedule(sessionId: string, firstMessageContent: string): void {
    setImmediate(() => {
      this.generate(sessionId, firstMessageContent).catch((err) => {
        this.logger.warn(
          `session-title 生成失败 session=${sessionId}：${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  private async generate(sessionId: string, content: string): Promise<void> {
    const cur = await this.sessions.findSessionOrFail(sessionId);
    if (cur.titleGenerated) return;

    const model = await this.graph.getModel();
    const promptText = this.buildPrompt(content);
    const res = await model.invoke(promptText);
    const raw = typeof res.content === "string" ? res.content : "";
    const title = sanitizeTitle(raw);
    if (!title) {
      this.logger.warn(`session-title LLM 返回空 session=${sessionId}`);
      return;
    }

    const updated = await this.sessions.patchIfNotGenerated(sessionId, title);
    if (!updated) return;

    this.emitter.emit(SESSION_WS_EVENTS.titleUpdated, {
      sessionId,
      title: updated.title,
    } satisfies SessionTitleUpdatedEvent);
  }

  private buildPrompt(content: string): string {
    const template = this.prompt.getPrompt("session-title") ?? FALLBACK_PROMPT;
    return template.replace("{{content}}", content);
  }
}

/**
 * 清洗 LLM 输出 —— trim、合并空白、剥首尾常见引号、硬截 30 字。
 * 空串返空串（调用方判空决定是否写库）。
 */
function sanitizeTitle(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  s = s.replace(/^[`'"「『《]+/, "").replace(/[`'"」』》]+$/, "");
  s = s.trim();
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX);
  return s;
}
```

- [ ] **Step 4：跑测试看通过**

```bash
pnpm jest apps/server-agent/src/services/session-title.service.spec.ts 2>&1 | tail -10
```

Expected：7 个 case 全部 PASS。

- [ ] **Step 5：在 SessionModule 注册**

编辑 `apps/server-agent/src/session.module.ts`，加 import + provider + export：

```ts
import { SessionTitleService } from "./services/session-title.service";

// providers 数组追加 SessionTitleService
providers: [
  SessionService,
  RunnerService,
  SessionGateway,
  LlmCallService,
  SessionMessageService,
  CheckpointerCleanupService,
  SessionTitleService,
],
// exports 同样追加（让控制器能 inject）
exports: [
  SessionService,
  RunnerService,
  LlmCallService,
  SessionMessageService,
  CheckpointerCleanupService,
  SessionTitleService,
],
```

- [ ] **Step 6：typecheck**

```bash
pnpm --filter @meshbot/server-agent typecheck
```

Expected：exit 0。

- [ ] **Step 7：commit**

```bash
git add apps/server-agent/src/services/session-title.service.ts \
        apps/server-agent/src/services/session-title.service.spec.ts \
        apps/server-agent/src/session.module.ts
git commit -m "$(cat <<'EOF'
feat(session): SessionTitleService 后台 LLM 生成标题

fire-and-forget setImmediate；findSession 短路 + patchIfNotGenerated
条件 update 双重防 race。LLM 失败 / 空返 / 用户改名都不影响主流程。
prompt 复用 PromptService 的 session-title.md，未定义时用代码内 fallback。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7：SessionController 触发 + Gateway 转发

**Files:**
- Modify: `apps/server-agent/src/controllers/session.controller.ts`
- Modify: `apps/server-agent/src/ws/session.gateway.ts`

- [ ] **Step 1：controller 改动**

`apps/server-agent/src/controllers/session.controller.ts`：

加 import：

```ts
import { SessionTitleService } from "../services/session-title.service";
```

constructor 注入：

```ts
constructor(
  private readonly sessions: SessionService,
  private readonly runner: RunnerService,
  private readonly llmCalls: LlmCallService,
  private readonly sessionMessages: SessionMessageService,
  private readonly titleService: SessionTitleService,
) {}
```

修改 `create`：

```ts
@Post()
async create(@Body() dto: CreateSessionDto): Promise<CreateSessionResponse> {
  const result = await this.sessions.createSession(dto);
  this.runner.kick(result.sessionId);
  this.titleService.schedule(result.sessionId, dto.content);
  return result;
}
```

- [ ] **Step 2：gateway 改动**

`apps/server-agent/src/ws/session.gateway.ts`：

加 import：

```ts
import {
  // ... 现有
  type SessionTitleUpdatedEvent,
} from "@meshbot/types-agent";
```

在现有最后一个 @OnEvent 之后追加：

```ts
/**
 * RunnerService / SessionTitleService → session.title_updated → namespace 广播。
 * 不路由到 session room：sidebar 是全局 UI、所有 socket（本地轨单用户）都应收到。
 */
@OnEvent(SESSION_WS_EVENTS.titleUpdated)
onTitleUpdated(payload: SessionTitleUpdatedEvent): void {
  this.server.emit(SESSION_WS_EVENTS.titleUpdated, payload);
}
```

- [ ] **Step 3：typecheck**

```bash
pnpm --filter @meshbot/server-agent typecheck
```

Expected：exit 0。

- [ ] **Step 4：手测**

启 server-agent：

```bash
pnpm dev:server-agent
```

另开终端：

```bash
# 创会话，等 ~3s 后 list 应看到新 title + titleGenerated=true
curl -sX POST localhost:3100/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"content":"帮我写一个 Python 快速排序"}' | jq .
# 拿 sessionId 后等几秒
sleep 5
curl -s localhost:3100/api/sessions | jq '.data.sessions[] | select(.titleGenerated == true)'
```

Expected：返回的 session title 不是原始 30 字截断、而是 LLM 生成的简短标题；titleGenerated=true。

- [ ] **Step 5：commit**

```bash
git add apps/server-agent/src/controllers/session.controller.ts \
        apps/server-agent/src/ws/session.gateway.ts
git commit -m "$(cat <<'EOF'
feat(session): create 后触发 title 生成 + ws 广播 title_updated

controller 注入 SessionTitleService，create 200 后 fire-and-forget schedule。
gateway 加 onTitleUpdated 把内部 EventEmitter 事件广播到整个 ws/session
namespace，sidebar 不需要 subscribe 任何 session room 就能收到。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8：前端 atom + AppShell 订阅

**Files:**
- Modify: `apps/web-agent/src/atoms/sessions.ts`
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`

- [ ] **Step 1：atom 加 updateSessionTitleAtom**

`apps/web-agent/src/atoms/sessions.ts` 末尾追加：

```ts
/**
 * 按 id 局部 patch session title + titleGenerated=true。
 * socket session.title_updated 收到 + 未来「重生成标题」入口共用。
 */
export const updateSessionTitleAtom = atom(
  null,
  (get, set, params: { id: string; title: string }) => {
    const arr = get(sessionsAtom);
    if (!arr.some((s) => s.id === params.id)) return;
    set(
      sessionsAtom,
      sortSessions(
        arr.map((s) =>
          s.id === params.id
            ? { ...s, title: params.title, titleGenerated: true }
            : s,
        ),
      ),
    );
  },
);
```

- [ ] **Step 2：AppShell 订阅**

`apps/web-agent/src/components/layouts/app-shell-layout.tsx`：

加 imports（合并到现有 @meshbot/types-agent 和 @/atoms/sessions imports）：

```ts
import {
  SESSION_WS_EVENTS,
  type SessionTitleUpdatedEvent,
} from "@meshbot/types-agent";
import { updateSessionTitleAtom /* + 现有 */ } from "@/atoms/sessions";
import { getSessionSocket } from "@/lib/socket";
```

component 内 `loadSessions` useEffect 旁边追加：

```ts
const updateSessionTitle = useSetAtom(updateSessionTitleAtom);

useEffect(() => {
  const socket = getSessionSocket();
  const onTitleUpdated = (e: SessionTitleUpdatedEvent) => {
    updateSessionTitle({ id: e.sessionId, title: e.title });
  };
  socket.on(SESSION_WS_EVENTS.titleUpdated, onTitleUpdated);
  return () => {
    socket.off(SESSION_WS_EVENTS.titleUpdated, onTitleUpdated);
  };
}, [updateSessionTitle]);
```

- [ ] **Step 3：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck
```

Expected：exit 0。

- [ ] **Step 4：commit**

```bash
git add apps/web-agent/src/atoms/sessions.ts \
        apps/web-agent/src/components/layouts/app-shell-layout.tsx
git commit -m "$(cat <<'EOF'
feat(web-agent): sidebar 订阅 session.title_updated 局部 patch

updateSessionTitleAtom 按 id 改 title + titleGenerated；AppShell 全程
活、订阅 namespace 广播事件 → sidebar 实时刷新标题。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9：e2e 手测 + final review

**Files:**
- 无代码改动，仅手测 + 跑全部测试与围栏

- [ ] **Step 1：全套测试**

```bash
pnpm typecheck
pnpm test
```

Expected：
- typecheck 24 个包退出码 0
- test 全部 PASS

- [ ] **Step 2：fences**

```bash
pnpm check
```

Expected：6 项围栏 0 finding。

- [ ] **Step 3：浏览器手测**

启 server-agent + web-agent，浏览器 http://localhost:3001：

1. 新建一个会话「帮我写一个 Python 快速排序」→ 跳转到 session 页 → 侧边栏立即出现「帮我写一个 Python 快速排序」（截 30 字 fallback）→ 1~3s 后侧边栏标题自动变成更短的 LLM 生成标题（如「Python 快排」）。
2. 新建另一个会话「介绍下 RAG」→ 立即在侧边栏插入 → 在 LLM 返回前手动右键改名为「自定义」→ 等 3s → 标题保持「自定义」不被 LLM 覆盖。
3. 后端 log 应看到 `[SessionTitleService]` 类相关 log，无 warn 报错。
4. `curl localhost:3100/api/sessions | jq` 验证 `titleGenerated` 字段对应。

不通过的 case 写下来回到对应 task 修。

- [ ] **Step 4：如有 commit 必要再 commit**

无代码改动则跳过。

---

## 自检（Self-Review）

**1. Spec 覆盖：**
- Entity title_generated + migration → Task 1 ✓
- types-agent SessionSummary + TitleUpdatedEvent + ws 常量 → Task 2 ✓
- 旧 fixture 补字段 → Task 3 ✓
- patch({title}) mark generated + patchIfNotGenerated → Task 4 ✓
- GraphService.getModel → Task 5 ✓
- SessionTitleService + sanitizeTitle + buildPrompt + FALLBACK_PROMPT → Task 6 ✓
- controller create 触发 + gateway broadcast → Task 7 ✓
- updateSessionTitleAtom + AppShell 订阅 → Task 8 ✓
- e2e 手测 → Task 9 ✓
- 「不主动重试，未来手动重生成」明确不做 ✓
- prompt 文件 session-title.md 不创建（spec 已声明） ✓

**2. 占位扫描：**
- 无 TBD / TODO；所有代码块完整；测试 case 全列了具体 expectation。

**3. 类型一致性：**
- `SessionSummary.titleGenerated: boolean` 贯穿 types-agent / SessionService.toSummary / atom 一致
- `SessionTitleUpdatedEvent = { sessionId, title }` 在 schema / gateway / atom 一致
- `SESSION_WS_EVENTS.titleUpdated = "session.title_updated"` 一致
- `patchIfNotGenerated(sessionId, title): Promise<SessionSummary | null>` 在 spec + Task 4 + Task 6 调用处一致

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-24-session-title-generation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
