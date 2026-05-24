# 侧边栏会话列表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把侧边栏写死的 session mockup 替换为真实的 list / pin / rename / delete 功能；前端 Jotai 单 atom 单一 source of truth + 乐观更新 + 客户端排序；首次加载有骨架屏；删除当前会话自动跳 `/`。

**Architecture:** 后端 sessions 表加 `pinned_at` 列 + 4 个 REST 端点（GET list / POST create 改返回 / PATCH update / DELETE cascade）；删除走 `SessionService.deleteSession`，事务内级联清四张表 + LangGraph checkpointer 两张表（`checkpoints` / `writes`），inflight 先 abort。前端在 `apps/web-agent/src/atoms/sessions.ts` 维护全列表 atom，sidebar 改 `app-shell-layout.tsx` 渲染 `<SessionListSection>` + `<SessionListItem>` + skeleton + delete dialog。

**Tech Stack:** NestJS（@Transactional / TxTypeOrmModule.forFeature）、TypeORM SQLite migration、Zod（types-agent）、Next.js + Jotai + lucide-react + shadcn DropdownMenu/AlertDialog、Biome、Jest（better-sqlite3 in-memory）。

---

## 文件结构

**Spec ref：** `docs/superpowers/specs/2026-05-24-sidebar-session-list-design.md`

### 后端（新建 / 修改）

| 路径 | 责任 |
|---|---|
| `apps/server-agent/src/entities/session.entity.ts`（改） | 加 `pinnedAt: Date \| null` 列 |
| `apps/server-agent/src/migrations/1779400000000-AddSessionsPinnedAt.ts`（新） | `ALTER TABLE` + 索引 |
| `libs/types-agent/src/session.ts`（改） | 加 `SessionSummarySchema` / `SessionListResponseSchema` / `SessionPatchSchema` / `SessionDeleteResponseSchema` / `CreateSessionResponseSchema` |
| `apps/server-agent/src/dto/session.dto.ts`（改） | 加 `SessionPatchDto`（createZodDto） |
| `apps/server-agent/src/services/session.service.ts`（改） | 加 `listAllSorted` / `patch` / `deleteSession`；改 `createSession` 返 `SessionSummary` |
| `apps/server-agent/src/services/llm-call.service.ts`（改） | 加 `deleteBySession(sessionId)` |
| `apps/server-agent/src/services/session-message.service.ts`（改） | 加 `deleteBySession(sessionId)` |
| `apps/server-agent/src/services/checkpointer-cleanup.service.ts`（新） | 用 `DataSource.query` 直接 `DELETE FROM checkpoints / writes WHERE thread_id = ?` |
| `apps/server-agent/src/controllers/session.controller.ts`（改） | 加 GET `/api/sessions`、PATCH `/api/sessions/:id`、DELETE `/api/sessions/:id`；改 POST 返回结构 |
| `apps/server-agent/src/session.module.ts`（改） | 注册 `CheckpointerCleanupService` |

### 前端（新建 / 修改）

| 路径 | 责任 |
|---|---|
| `libs/types-agent/src/session.ts`（同上） | 共享 schema/types |
| `apps/web-agent/src/rest/session.ts`（改） | 加 `listSessions` / `patchSession` / `deleteSession`；改 `createSession` 返回 `SessionSummary` |
| `apps/web-agent/src/atoms/sessions.ts`（新） | 全部 sessions atom + status atom + 派生 pinned/recent + 排序 + 异步 setter（rename/togglePin/delete/add/load） |
| `apps/web-agent/src/components/sidebar/session-list-section.tsx`（新） | 一段标题 + 子项列表 |
| `apps/web-agent/src/components/sidebar/session-list-item.tsx`（新） | 单条会话：默认/编辑/激活 三态 + 三点菜单 |
| `apps/web-agent/src/components/sidebar/session-list-skeleton.tsx`（新） | 骨架占位 6 条 |
| `apps/web-agent/src/components/sidebar/session-delete-dialog.tsx`（新） | AlertDialog 确认 |
| `apps/web-agent/src/components/layouts/app-shell-layout.tsx`（改） | 删 mockup，挂 loader + sections |
| `apps/web-agent/src/app/page.tsx`（改） | 创会话成功后 `addSessionAtom` + push |
| `apps/web-agent/messages/zh.json` / `en.json`（改） | 文案 |

---

## Task 1：后端 — Session entity 加 `pinnedAt` + migration

**Files:**
- Modify: `apps/server-agent/src/entities/session.entity.ts`
- Create: `apps/server-agent/src/migrations/1779400000000-AddSessionsPinnedAt.ts`

- [ ] **Step 1：改 entity**

把 `session.entity.ts` 改为：

```ts
import type { SessionStatus } from "@meshbot/types-agent";
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/** 会话表。id 同时作为 LangGraph thread_id 与 socket.io room id。 */
@Entity("sessions")
export class Session {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  title!: string;

  /** idle = 无 run 在跑；running = 有 run 在跑。 */
  @Column({ type: "varchar", default: "idle" })
  status!: SessionStatus;

  /**
   * 非 null = 已固定。值 = 固定时间，用于「最近固定的在上」排序，也作未来
   * drag-to-pin 重排的字段。不引入额外 boolean 字段：单字段同时承担状态 + 顺序，
   * 避免不一致。
   */
  @Column({ name: "pinned_at", type: "datetime", nullable: true })
  pinnedAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
```

- [ ] **Step 2：写 migration**

新建 `apps/server-agent/src/migrations/1779400000000-AddSessionsPinnedAt.ts`：

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * sessions 表加 pinned_at 列 —— 单字段同时承担「是否固定」+「固定顺序」。
 * 索引覆盖 list 排序：CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END, pinned_at DESC, updated_at DESC。
 */
export class AddSessionsPinnedAt1779400000000 implements MigrationInterface {
  name = "AddSessionsPinnedAt1779400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "pinned_at" DATETIME`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_sessions_pinned_updated" ON "sessions" ("pinned_at", "updated_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_sessions_pinned_updated"`,
    );
    // SQLite 不支持 DROP COLUMN；重建表代价大且本地轨数据为 dev，保留列即可
  }
}
```

- [ ] **Step 3：跑 migration + typecheck**

```bash
pnpm --filter @meshbot/server-agent typecheck
```

Expected：`tsc` 退出码 0。

```bash
pnpm dev:server-agent
```

启动后控制台应有日志类似 `Migration AddSessionsPinnedAt1779400000000 has been executed successfully`。手停掉。

- [ ] **Step 4：commit**

```bash
git add apps/server-agent/src/entities/session.entity.ts \
        apps/server-agent/src/migrations/1779400000000-AddSessionsPinnedAt.ts
git commit -m "$(cat <<'EOF'
feat(session): sessions 加 pinned_at 列 + 索引

单字段同时承担「是否固定」+「固定顺序」，为未来 drag-to-pin 预留。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2：types-agent 加 SessionSummary / 端点出入参 schema

**Files:**
- Modify: `libs/types-agent/src/session.ts`
- Test: `libs/types-agent/src/session.spec.ts`

- [ ] **Step 1：先写测试（失败的）**

在 `libs/types-agent/src/session.spec.ts` 末尾追加：

```ts
import {
  SessionSummarySchema,
  SessionListResponseSchema,
  SessionPatchSchema,
  CreateSessionResponseSchema,
  SessionDeleteResponseSchema,
} from "./session";

describe("session schemas — sidebar list", () => {
  it("SessionSummarySchema 通过基本字段", () => {
    const ok = SessionSummarySchema.parse({
      id: "s1",
      title: "hi",
      status: "idle",
      pinned: false,
      pinnedAt: null,
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    });
    expect(ok.pinned).toBe(false);
  });

  it("SessionPatchSchema 至少传 title 或 pinned 之一", () => {
    expect(() => SessionPatchSchema.parse({})).toThrow();
    expect(SessionPatchSchema.parse({ title: "x" }).title).toBe("x");
    expect(SessionPatchSchema.parse({ pinned: true }).pinned).toBe(true);
    expect(
      SessionPatchSchema.parse({ title: "x", pinned: true }).title,
    ).toBe("x");
  });

  it("SessionPatchSchema 限制 title 长度 1..200", () => {
    expect(() => SessionPatchSchema.parse({ title: "" })).toThrow();
    expect(() =>
      SessionPatchSchema.parse({ title: "x".repeat(201) }),
    ).toThrow();
  });

  it("SessionListResponseSchema 是 sessions 数组", () => {
    const ok = SessionListResponseSchema.parse({ sessions: [] });
    expect(ok.sessions).toEqual([]);
  });

  it("CreateSessionResponseSchema 同时带 sessionId 和 session", () => {
    const r = CreateSessionResponseSchema.parse({
      sessionId: "s1",
      session: {
        id: "s1",
        title: "hi",
        status: "running",
        pinned: false,
        pinnedAt: null,
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
      },
    });
    expect(r.sessionId).toBe("s1");
  });

  it("SessionDeleteResponseSchema 必须 deleted=true", () => {
    expect(SessionDeleteResponseSchema.parse({ deleted: true }).deleted).toBe(
      true,
    );
    expect(() =>
      SessionDeleteResponseSchema.parse({ deleted: false }),
    ).toThrow();
  });
});
```

- [ ] **Step 2：跑测试看失败**

```bash
pnpm --filter @meshbot/types-agent test -- session.spec
```

Expected：FAIL（找不到导出符号）。

- [ ] **Step 3：实现 schemas**

在 `libs/types-agent/src/session.ts` **文件开头 import 之后** 紧跟 `SessionStatus` 定义之后插入：

```ts
/** 侧边栏 + 创会话接口共用的会话概要。 */
export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: SessionStatus,
  /** 派生：pinnedAt != null。客户端用做语义判断，避免每处都比较 pinnedAt。 */
  pinned: z.boolean(),
  /** ISO 时间字符串；非 null 即已固定，值用于客户端排序与未来重排。 */
  pinnedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** GET /api/sessions 出参。 */
export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
});
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

/**
 * PATCH /api/sessions/:id 入参。title / pinned 至少传一个。
 * - pinned=true 会写当前时间到 pinned_at（最近固定的排到顶）。
 * - pinned=false 会把 pinned_at 置 null。
 */
export const SessionPatchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((d) => d.title !== undefined || d.pinned !== undefined, {
    message: "至少传 title 或 pinned 之一",
  });
export type SessionPatchInput = z.infer<typeof SessionPatchSchema>;

/** DELETE /api/sessions/:id 出参。 */
export const SessionDeleteResponseSchema = z.object({
  deleted: z.literal(true),
});
export type SessionDeleteResponse = z.infer<typeof SessionDeleteResponseSchema>;
```

把现有 `CreateSessionSchema` 下面追加 create 响应 schema（**不动 CreateSessionSchema 本身**）：

```ts
/**
 * POST /api/sessions 出参。兼容老调用方：保留顶层 sessionId 不变，追加 session
 * 字段，前端用 session 完整对象插入 sessionsAtom（无需二次 GET）。
 */
export const CreateSessionResponseSchema = z.object({
  sessionId: z.string(),
  session: SessionSummarySchema,
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
```

- [ ] **Step 4：跑测试看通过**

```bash
pnpm --filter @meshbot/types-agent test -- session.spec
```

Expected：PASS。

- [ ] **Step 5：commit**

```bash
git add libs/types-agent/src/session.ts libs/types-agent/src/session.spec.ts
git commit -m "$(cat <<'EOF'
feat(types-agent): SessionSummary + list/patch/delete/create 响应 schema

SessionSummary 同时带 pinned (bool 派生) 和 pinnedAt (排序键)。SessionPatch
refine 至少传一项。CreateSessionResponse 兼容老顶层 sessionId 不变。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3：SessionService 加 `listAllSorted` + 单测

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`
- Test: `apps/server-agent/src/services/session.service.spec.ts`

- [ ] **Step 1：先写测试（失败的）**

在 `session.service.spec.ts` 末尾追加：

```ts
describe("listAllSorted", () => {
  it("已固定优先；都固定按 pinnedAt desc；未固定按 updatedAt desc", async () => {
    // 创 4 个会话，错开时间
    const a = await service.createSession({ content: "A" });
    await new Promise((r) => setTimeout(r, 10));
    const b = await service.createSession({ content: "B" });
    await new Promise((r) => setTimeout(r, 10));
    const c = await service.createSession({ content: "C" });
    await new Promise((r) => setTimeout(r, 10));
    const d = await service.createSession({ content: "D" });

    // pin b（早），再 pin d（晚） → d 应在 b 之前
    await service.patch(b.sessionId, { pinned: true });
    await new Promise((r) => setTimeout(r, 10));
    await service.patch(d.sessionId, { pinned: true });

    const rows = await service.listAllSorted();
    const ids = rows.map((s) => s.id);
    // 顺序：[d, b, c, a]（pinned 优先；pinned 内 d 新；未 pinned 内 c 新）
    expect(ids).toEqual([d.sessionId, b.sessionId, c.sessionId, a.sessionId]);
  });

  it("空列表返 []", async () => {
    const rows = await service.listAllSorted();
    expect(rows).toEqual([]);
  });
});
```

注意这个测试**依赖 Task 4 的 `patch` 方法**。两个 task 拆开是为了让 review 粒度细些；实施时 Task 3 + 4 实质同期 + 同测试文件，把 `patch` 的具体实现也写在 Task 4 里再跑总测试。先**只**写 `listAllSorted` 实现 + 跳过 `patch` 相关那个 case（用 `it.skip`），下一 task 再 unskip。

把上面的两段：第一段 `it(...)` 改成 `it.skip(...)`（实施 task 5 时去掉 skip）。

- [ ] **Step 2：跑测试看失败**

```bash
pnpm --filter @meshbot/server-agent test -- session.service.spec
```

Expected：第二个 case（空列表）报 `service.listAllSorted is not a function`。

- [ ] **Step 3：实现 `listAllSorted`**

在 `SessionService` 类里追加：

```ts
/**
 * 列出全部会话，按「固定优先 / 固定组按 pinnedAt desc / 其余按 updatedAt desc」
 * 排序。客户端 sortSessions 与之等价。
 *
 * id desc 作 tie-breaker（避免同毫秒漂移）。当前 dev 量级一次性全取，未来上
 * 千再加分页。
 */
async listAllSorted(): Promise<Session[]> {
  return this.sessionRepo
    .createQueryBuilder("s")
    .orderBy("CASE WHEN s.pinned_at IS NULL THEN 1 ELSE 0 END", "ASC")
    .addOrderBy("s.pinned_at", "DESC")
    .addOrderBy("s.updated_at", "DESC")
    .addOrderBy("s.id", "DESC")
    .getMany();
}
```

- [ ] **Step 4：跑测试看通过**

```bash
pnpm --filter @meshbot/server-agent test -- session.service.spec
```

Expected：空列表 case PASS。

- [ ] **Step 5：commit**

```bash
git add apps/server-agent/src/services/session.service.ts \
        apps/server-agent/src/services/session.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(session): listAllSorted（pinned 优先 + pinned_at/updated_at desc）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4：SessionService 加 `patch`（title / pinned） + 单测

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`
- Test: `apps/server-agent/src/services/session.service.spec.ts`

- [ ] **Step 1：先写测试（失败的）**

在 `session.service.spec.ts` 末尾追加：

```ts
describe("patch", () => {
  it("更新 title", async () => {
    const { sessionId } = await service.createSession({ content: "old" });
    const updated = await service.patch(sessionId, { title: "new title" });
    expect(updated.title).toBe("new title");
  });

  it("pinned=true 写 pinned_at；pinned=false 置 null", async () => {
    const { sessionId } = await service.createSession({ content: "x" });
    let s = await service.patch(sessionId, { pinned: true });
    expect(s.pinnedAt).not.toBeNull();
    s = await service.patch(sessionId, { pinned: false });
    expect(s.pinnedAt).toBeNull();
  });

  it("同时更新 title 和 pinned", async () => {
    const { sessionId } = await service.createSession({ content: "x" });
    const s = await service.patch(sessionId, {
      title: "T",
      pinned: true,
    });
    expect(s.title).toBe("T");
    expect(s.pinnedAt).not.toBeNull();
  });

  it("不存在的 id 抛 NotFoundException", async () => {
    await expect(service.patch("nope", { title: "x" })).rejects.toThrow(
      NotFoundException,
    );
  });
});
```

同时把 Task 3 里 `it.skip(...)` 那个排序综合 case 改回 `it(...)`。

- [ ] **Step 2：跑测试看失败**

```bash
pnpm --filter @meshbot/server-agent test -- session.service.spec
```

Expected：`service.patch is not a function`。

- [ ] **Step 3：实现 `patch`**

在 `SessionService` 类里追加：

```ts
/**
 * 更新会话 title / pinned。至少传一项（Zod 在控制器 DTO 层已保证）。
 * pinned: true → 写当前时间到 pinned_at；pinned: false → null。
 * 单表 update，无需事务。
 */
async patch(
  sessionId: string,
  input: { title?: string; pinned?: boolean },
): Promise<Session> {
  const patch: Partial<Session> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.pinned !== undefined) {
    patch.pinnedAt = input.pinned ? new Date() : null;
  }
  await this.sessionRepo.update({ id: sessionId }, patch);
  return this.findSessionOrFail(sessionId);
}
```

- [ ] **Step 4：跑测试看通过**

```bash
pnpm --filter @meshbot/server-agent test -- session.service.spec
```

Expected：所有 patch case + Task 3 的综合排序 case PASS。

- [ ] **Step 5：commit**

```bash
git add apps/server-agent/src/services/session.service.ts \
        apps/server-agent/src/services/session.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(session): patch (title / pinned)

pinned: true → pinned_at = now；false → null。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5：LlmCallService / SessionMessageService 加 `deleteBySession`

**Files:**
- Modify: `apps/server-agent/src/services/llm-call.service.ts`
- Modify: `apps/server-agent/src/services/session-message.service.ts`
- Test: `apps/server-agent/src/services/llm-call.service.spec.ts`
- Test: `apps/server-agent/src/services/session-message.service.spec.ts`

- [ ] **Step 1：先写 LlmCallService 测试**

在 `llm-call.service.spec.ts` 末尾追加：

```ts
it("deleteBySession 删该会话全部记录", async () => {
  await service.record({
    sessionId: "s1",
    messageId: "m1",
    providerType: "p",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    durationMs: 1,
  });
  await service.record({
    sessionId: "s2",
    messageId: "m2",
    providerType: "p",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    durationMs: 1,
  });
  await service.deleteBySession("s1");
  const remain1 = await service.listBySession("s1");
  const remain2 = await service.listBySession("s2");
  expect(remain1).toHaveLength(0);
  expect(remain2).toHaveLength(1);
});
```

- [ ] **Step 2：跑测试看失败**

```bash
pnpm --filter @meshbot/server-agent test -- llm-call.service.spec
```

Expected：`deleteBySession is not a function`。

- [ ] **Step 3：实现 LlmCallService.deleteBySession**

在 `llm-call.service.ts` 末尾追加：

```ts
/** 删某会话全部 LLM 调用观测（仅 session 删除时调用）。 */
async deleteBySession(sessionId: string): Promise<void> {
  await this.llmCallRepo.delete({ sessionId });
}
```

- [ ] **Step 4：跑测试看通过**

```bash
pnpm --filter @meshbot/server-agent test -- llm-call.service.spec
```

Expected：PASS。

- [ ] **Step 5：写 SessionMessageService 测试**

在 `session-message.service.spec.ts` 末尾追加：

```ts
it("deleteBySession 删该会话全部消息", async () => {
  await service.recordUser({ id: "u1", sessionId: "s1", content: "a" });
  await service.recordUser({ id: "u2", sessionId: "s2", content: "b" });
  await service.deleteBySession("s1");
  const p1 = await service.listPage("s1", { limit: 10 });
  const p2 = await service.listPage("s2", { limit: 10 });
  expect(p1.messages).toHaveLength(0);
  expect(p2.messages).toHaveLength(1);
});
```

- [ ] **Step 6：跑测试看失败**

```bash
pnpm --filter @meshbot/server-agent test -- session-message.service.spec
```

Expected：`deleteBySession is not a function`。

- [ ] **Step 7：实现 SessionMessageService.deleteBySession**

在 `session-message.service.ts` 类里追加：

```ts
/** 删某会话全部 session_messages（仅 session 删除时调用）。 */
async deleteBySession(sessionId: string): Promise<void> {
  await this.repo.delete({ sessionId });
}
```

- [ ] **Step 8：跑测试看通过**

```bash
pnpm --filter @meshbot/server-agent test -- session-message.service.spec
```

Expected：PASS。

- [ ] **Step 9：commit**

```bash
git add apps/server-agent/src/services/llm-call.service.ts \
        apps/server-agent/src/services/llm-call.service.spec.ts \
        apps/server-agent/src/services/session-message.service.ts \
        apps/server-agent/src/services/session-message.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(session): LlmCall / SessionMessage 加 deleteBySession

供 SessionService.deleteSession 级联调用。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6：CheckpointerCleanupService（清 LangGraph 两张表）

**Files:**
- Create: `apps/server-agent/src/services/checkpointer-cleanup.service.ts`
- Test: `apps/server-agent/src/services/checkpointer-cleanup.service.spec.ts`
- Modify: `apps/server-agent/src/session.module.ts`

- [ ] **Step 1：先写测试**

新建 `apps/server-agent/src/services/checkpointer-cleanup.service.spec.ts`：

```ts
import { DataSource } from "typeorm";
import { CheckpointerCleanupService } from "./checkpointer-cleanup.service";

describe("CheckpointerCleanupService", () => {
  let ds: DataSource;
  let service: CheckpointerCleanupService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      synchronize: false,
    });
    await ds.initialize();
    // 用与 SqliteSaver 一致的 schema（最小列集合，足以测 DELETE）
    await ds.query(`
      CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `);
    await ds.query(`
      CREATE TABLE writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )
    `);
    await ds.query(
      `INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id) VALUES ('t1', '', 'c1'), ('t2', '', 'c2')`,
    );
    await ds.query(
      `INSERT INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel) VALUES ('t1', '', 'c1', 'tk1', 0, 'ch'), ('t2', '', 'c2', 'tk2', 0, 'ch')`,
    );
    service = new CheckpointerCleanupService(ds);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("deleteThread 删 checkpoints + writes 中对应 thread_id 的行", async () => {
    await service.deleteThread("t1");
    const cp = await ds.query(`SELECT thread_id FROM checkpoints`);
    const wr = await ds.query(`SELECT thread_id FROM writes`);
    expect(cp.map((r: { thread_id: string }) => r.thread_id)).toEqual(["t2"]);
    expect(wr.map((r: { thread_id: string }) => r.thread_id)).toEqual(["t2"]);
  });

  it("deleteThread 对不存在的 thread_id 不报错", async () => {
    await expect(service.deleteThread("nope")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2：跑测试看失败**

```bash
pnpm --filter @meshbot/server-agent test -- checkpointer-cleanup.service.spec
```

Expected：`Cannot find module './checkpointer-cleanup.service'`。

- [ ] **Step 3：实现 service**

新建 `apps/server-agent/src/services/checkpointer-cleanup.service.ts`：

```ts
import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

/**
 * 清 LangGraph SqliteSaver 的 checkpoints / writes 表 —— SqliteSaver 没暴露
 * deleteThread，故走 DataSource raw query。
 *
 * 表名与 @langchain/langgraph-checkpoint-sqlite 0.1.x 强耦合；若升级集成包
 * 后表名变了，在此 service 内集中改一处即可。
 */
@Injectable()
export class CheckpointerCleanupService {
  constructor(
    @InjectDataSource()
    private readonly ds: DataSource,
  ) {}

  /** 删某 thread_id 的全部 checkpoints + writes。幂等：不存在不报错。 */
  async deleteThread(threadId: string): Promise<void> {
    await this.ds.query(`DELETE FROM checkpoints WHERE thread_id = ?`, [
      threadId,
    ]);
    await this.ds.query(`DELETE FROM writes WHERE thread_id = ?`, [threadId]);
  }
}
```

- [ ] **Step 4：跑测试看通过**

```bash
pnpm --filter @meshbot/server-agent test -- checkpointer-cleanup.service.spec
```

Expected：PASS。

- [ ] **Step 5：在 SessionModule providers 注册**

编辑 `apps/server-agent/src/session.module.ts`，在 `providers` / `exports` 数组加入 `CheckpointerCleanupService`：

```ts
import { CheckpointerCleanupService } from "./services/checkpointer-cleanup.service";
// ...
providers: [
  SessionService,
  RunnerService,
  SessionGateway,
  LlmCallService,
  SessionMessageService,
  CheckpointerCleanupService,
],
exports: [
  SessionService,
  RunnerService,
  LlmCallService,
  SessionMessageService,
  CheckpointerCleanupService,
],
```

- [ ] **Step 6：typecheck**

```bash
pnpm --filter @meshbot/server-agent typecheck
```

Expected：退出码 0。

- [ ] **Step 7：commit**

```bash
git add apps/server-agent/src/services/checkpointer-cleanup.service.ts \
        apps/server-agent/src/services/checkpointer-cleanup.service.spec.ts \
        apps/server-agent/src/session.module.ts
git commit -m "$(cat <<'EOF'
feat(session): CheckpointerCleanupService — 删 LangGraph 两表

SqliteSaver 没暴露 deleteThread，走 DataSource raw DELETE。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7：SessionService 加 `deleteSession`（事务级联）+ 单测

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`
- Test: `apps/server-agent/src/services/session.service.spec.ts`

- [ ] **Step 1：写测试**

在 `session.service.spec.ts` 顶部 import 加 `CheckpointerCleanupService`、`LlmCallService`、`SessionMessageService`、`LlmCall`、`SessionMessage`：

```ts
import { CheckpointerCleanupService } from "./checkpointer-cleanup.service";
import { LlmCallService } from "./llm-call.service";
import { SessionMessageService } from "./session-message.service";
import { LlmCall } from "../entities/llm-call.entity";
import { SessionMessage } from "../entities/session-message.entity";
```

改 `beforeEach`：

```ts
beforeEach(async () => {
  ds = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Session, PendingMessage, LlmCall, SessionMessage],
    synchronize: true,
  });
  await ds.initialize();
  // checkpointer 两张表手工建（生产由集成包自建）
  await ds.query(`
    CREATE TABLE checkpoints (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL DEFAULT '',
      checkpoint_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    )
  `);
  await ds.query(`
    CREATE TABLE writes (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL DEFAULT '',
      checkpoint_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
    )
  `);
  const llmCalls = new LlmCallService(ds.getRepository(LlmCall));
  const sessionMessages = new SessionMessageService(
    ds.getRepository(SessionMessage),
  );
  const checkpointer = new CheckpointerCleanupService(ds);
  service = new SessionService(
    ds.getRepository(Session),
    ds.getRepository(PendingMessage),
    llmCalls,
    sessionMessages,
    checkpointer,
  );
  // 暴露给 deleteSession 测试用
  (service as unknown as { __ds: DataSource }).__ds = ds;
});
```

末尾追加 deleteSession 测试块：

```ts
describe("deleteSession", () => {
  async function seedAll(sessionId: string): Promise<void> {
    const ds = (service as unknown as { __ds: DataSource }).__ds;
    await ds.query(
      `INSERT INTO session_messages (id, session_id, role, content) VALUES (?, ?, 'user', 'x')`,
      [`msg-${sessionId}`, sessionId],
    );
    await ds.query(
      `INSERT INTO llm_calls (id, session_id, message_id, provider_type, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, duration_ms) VALUES (?, ?, 'm', 'p', 'mo', 0, 0, 0, 0, 0, 0, 0)`,
      [`call-${sessionId}`, sessionId],
    );
    await ds.query(
      `INSERT INTO checkpoints (thread_id, checkpoint_id) VALUES (?, 'c')`,
      [sessionId],
    );
    await ds.query(
      `INSERT INTO writes (thread_id, checkpoint_id, task_id, idx) VALUES (?, 'c', 't', 0)`,
      [sessionId],
    );
  }
  it("级联删 sessions + pending + session_messages + llm_calls + checkpointer", async () => {
    const { sessionId } = await service.createSession({ content: "x" });
    await seedAll(sessionId);
    await service.deleteSession(sessionId);
    const ds = (service as unknown as { __ds: DataSource }).__ds;
    expect(
      await ds.query(`SELECT 1 FROM sessions WHERE id = ?`, [sessionId]),
    ).toHaveLength(0);
    expect(
      await ds.query(`SELECT 1 FROM pending_messages WHERE session_id = ?`, [
        sessionId,
      ]),
    ).toHaveLength(0);
    expect(
      await ds.query(`SELECT 1 FROM session_messages WHERE session_id = ?`, [
        sessionId,
      ]),
    ).toHaveLength(0);
    expect(
      await ds.query(`SELECT 1 FROM llm_calls WHERE session_id = ?`, [
        sessionId,
      ]),
    ).toHaveLength(0);
    expect(
      await ds.query(`SELECT 1 FROM checkpoints WHERE thread_id = ?`, [
        sessionId,
      ]),
    ).toHaveLength(0);
    expect(
      await ds.query(`SELECT 1 FROM writes WHERE thread_id = ?`, [sessionId]),
    ).toHaveLength(0);
  });

  it("不影响其他 session", async () => {
    const s1 = await service.createSession({ content: "a" });
    const s2 = await service.createSession({ content: "b" });
    await seedAll(s1.sessionId);
    await seedAll(s2.sessionId);
    await service.deleteSession(s1.sessionId);
    const ds = (service as unknown as { __ds: DataSource }).__ds;
    expect(
      await ds.query(`SELECT 1 FROM sessions WHERE id = ?`, [s2.sessionId]),
    ).toHaveLength(1);
  });

  it("不存在 id 抛 NotFoundException", async () => {
    await expect(service.deleteSession("nope")).rejects.toThrow(
      NotFoundException,
    );
  });
});
```

- [ ] **Step 2：跑测试看失败**

```bash
pnpm --filter @meshbot/server-agent test -- session.service.spec
```

Expected：`service.deleteSession is not a function`（以及构造器参数不匹配 → 先跳过修构造器再 fail）。

- [ ] **Step 3：改 SessionService 构造器 + 实现 `deleteSession`**

把 `session.service.ts` 顶部 import 加：

```ts
import { LlmCallService } from "./llm-call.service";
import { SessionMessageService } from "./session-message.service";
import { CheckpointerCleanupService } from "./checkpointer-cleanup.service";
```

改构造器：

```ts
constructor(
  @InjectRepository(Session)
  private readonly sessionRepo: Repository<Session>,
  @InjectRepository(PendingMessage)
  private readonly pendingRepo: Repository<PendingMessage>,
  private readonly llmCalls: LlmCallService,
  private readonly sessionMessages: SessionMessageService,
  private readonly checkpointer: CheckpointerCleanupService,
) {}
```

末尾追加 `deleteSession`：

```ts
/**
 * 级联删除整条会话：先确认存在抛 404，再事务内按顺序删
 * llm_calls / session_messages / pending_messages / sessions，
 * 事务外删 checkpointer 两张表（不在 TxTypeOrm 注册范围）。
 *
 * 这里没 interrupt inflight：在 controller 层处理（先 runner.interrupt 再调本方法），
 * 让 service 保持「纯数据层」。
 */
async deleteSession(sessionId: string): Promise<void> {
  await this.findSessionOrFail(sessionId);
  await this.deleteSessionInTx(sessionId);
  await this.checkpointer.deleteThread(sessionId);
}

@Transactional()
private async deleteSessionInTx(sessionId: string): Promise<void> {
  await this.llmCalls.deleteBySession(sessionId);
  await this.sessionMessages.deleteBySession(sessionId);
  await this.pendingRepo.delete({ sessionId });
  await this.sessionRepo.delete({ id: sessionId });
}
```

注意 `deleteSessionInTx` 命名符合 `check:naming` 私有事务方法约定（`*InTx` 后缀）。

- [ ] **Step 4：跑测试看通过**

```bash
pnpm --filter @meshbot/server-agent test -- session.service.spec
```

Expected：PASS。

- [ ] **Step 5：跑围栏（check:repo、check:tx、check:naming）**

```bash
pnpm check:repo && pnpm check:tx && pnpm check:naming && pnpm check:lock-tx
```

Expected：全 0 finding。`check:repo` 重点：`SessionService` 跨域注入 `LlmCallService` / `SessionMessageService` 是合法的（service 调 service，不直接 inject 别人的 Repository）。

- [ ] **Step 6：commit**

```bash
git add apps/server-agent/src/services/session.service.ts \
        apps/server-agent/src/services/session.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(session): deleteSession 事务级联（llm_calls/messages/pending/sessions/checkpointer）

事务内删 4 张归属表；事务外删 checkpointer 两张表（不在 TxTypeOrm 范围）。
按 check:naming 约定私有方法名 *InTx。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8：改 `createSession` 返回 `SessionSummary`

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`
- Modify: `apps/server-agent/src/services/session.service.spec.ts`

- [ ] **Step 1：测试**

在 spec 末尾追加：

```ts
describe("createSession 返回 SessionSummary", () => {
  it("返 sessionId + session 完整对象", async () => {
    const r = await service.createSession({ content: "hello" });
    expect(r.sessionId).toBeDefined();
    expect(r.session.id).toBe(r.sessionId);
    expect(r.session.title).toBe("hello");
    expect(r.session.status).toBe("running");
    expect(r.session.pinned).toBe(false);
    expect(r.session.pinnedAt).toBeNull();
    expect(typeof r.session.createdAt).toBe("string");
    expect(typeof r.session.updatedAt).toBe("string");
  });
});
```

把 `session.service.ts` 现有 `createSession` 接口签名也要更新（Task 3 / 4 的旧测试若调 `service.createSession({...})` 只用 `sessionId`，仍兼容 —— 因为我们只是**追加** session 字段，旧 case 不引用 session 不影响）。

- [ ] **Step 2：跑测试看失败**

```bash
pnpm --filter @meshbot/server-agent test -- session.service.spec
```

Expected：`r.session` undefined。

- [ ] **Step 3：实现**

在 `session.service.ts` 顶部加一个 helper：

```ts
import type { SessionSummary } from "@meshbot/types-agent";

function toSummary(s: Session): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    pinned: s.pinnedAt !== null,
    pinnedAt: s.pinnedAt ? s.pinnedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
```

改 `createSession` 与 `createSessionInTx`：

```ts
async createSession(
  input: CreateSessionInput,
): Promise<{ sessionId: string; session: SessionSummary }> {
  return this.createSessionInTx(input);
}

@Transactional()
private async createSessionInTx(
  input: CreateSessionInput,
): Promise<{ sessionId: string; session: SessionSummary }> {
  const saved = await this.sessionRepo.save(
    this.sessionRepo.create({
      title: input.content.slice(0, TITLE_MAX),
      status: "running",
    }),
  );
  await this.pendingRepo.save(
    this.pendingRepo.create({
      sessionId: saved.id,
      content: input.content,
      status: "pending",
    }),
  );
  return { sessionId: saved.id, session: toSummary(saved) };
}
```

改 `patch` 让它也返回 `SessionSummary`：

```ts
async patch(
  sessionId: string,
  input: { title?: string; pinned?: boolean },
): Promise<SessionSummary> {
  const patch: Partial<Session> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.pinned !== undefined) {
    patch.pinnedAt = input.pinned ? new Date() : null;
  }
  await this.sessionRepo.update({ id: sessionId }, patch);
  const s = await this.findSessionOrFail(sessionId);
  return toSummary(s);
}
```

把 Task 4 的 patch 测试也对应更新（如 `expect(s.title).toBe('new title')` 已 OK，`expect(s.pinnedAt).toBeNull()` → 需改 `expect(s.pinnedAt).toBeNull()` 仍 OK（toSummary 处 null 仍 null），但 `pinnedAt: new Date()` 时 toSummary 后是 string —— Task 4 测试里 `expect(s.pinnedAt).not.toBeNull()` 也 OK。

改 `listAllSorted` 返 `SessionSummary[]`（Task 3）：

```ts
async listAllSorted(): Promise<SessionSummary[]> {
  const rows = await this.sessionRepo
    .createQueryBuilder("s")
    .orderBy("CASE WHEN s.pinned_at IS NULL THEN 1 ELSE 0 END", "ASC")
    .addOrderBy("s.pinned_at", "DESC")
    .addOrderBy("s.updated_at", "DESC")
    .addOrderBy("s.id", "DESC")
    .getMany();
  return rows.map(toSummary);
}
```

Task 3 测试里 `rows.map(s => s.id)` 仍 OK（SessionSummary 也有 id）。

- [ ] **Step 4：跑测试看通过**

```bash
pnpm --filter @meshbot/server-agent test -- session.service.spec
```

Expected：全部 PASS。

- [ ] **Step 5：commit**

```bash
git add apps/server-agent/src/services/session.service.ts \
        apps/server-agent/src/services/session.service.spec.ts
git commit -m "$(cat <<'EOF'
refactor(session): createSession / patch / listAllSorted 统一返 SessionSummary

通过 toSummary helper 集中 Date → ISO 字符串 + pinned 派生，避免散落。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9：DTO + 控制器端点（GET / PATCH / DELETE，改 POST 返回）

**Files:**
- Modify: `apps/server-agent/src/dto/session.dto.ts`
- Modify: `apps/server-agent/src/controllers/session.controller.ts`

- [ ] **Step 1：加 DTO**

`apps/server-agent/src/dto/session.dto.ts` 末尾追加：

```ts
import { SessionPatchSchema } from "@meshbot/types-agent";

/** PATCH /api/sessions/:id 入参 DTO（title / pinned 至少传一项）。 */
export class SessionPatchDto extends createZodDto(SessionPatchSchema) {}
```

- [ ] **Step 2：控制器加方法**

编辑 `apps/server-agent/src/controllers/session.controller.ts`：

顶部 import 追加：

```ts
import type {
  SessionListResponse,
  SessionSummary,
  CreateSessionResponse,
  SessionDeleteResponse,
} from "@meshbot/types-agent";
import { Patch } from "@nestjs/common";
import { SessionPatchDto } from "../dto/session.dto";
```

改 `create` 返回类型：

```ts
@Post()
async create(@Body() dto: CreateSessionDto): Promise<CreateSessionResponse> {
  const result = await this.sessions.createSession(dto);
  this.runner.kick(result.sessionId);
  return result;
}
```

类里追加：

```ts
/** GET /api/sessions —— 全量已排序，首屏前端一次性加载。 */
@Get()
async list(): Promise<SessionListResponse> {
  const sessions = await this.sessions.listAllSorted();
  return { sessions };
}

/** PATCH /api/sessions/:id —— title / pinned 至少传一项。 */
@Patch(":id")
async patch(
  @Param("id") id: string,
  @Body() dto: SessionPatchDto,
): Promise<SessionSummary> {
  await this.sessions.findSessionOrFail(id);
  return this.sessions.patch(id, dto);
}

/** DELETE /api/sessions/:id —— 级联清四张表 + checkpointer 两表；先 abort inflight。 */
@Delete(":id")
async remove(@Param("id") id: string): Promise<SessionDeleteResponse> {
  this.runner.interrupt(id); // 幂等：没在跑则 no-op
  await this.sessions.deleteSession(id);
  return { deleted: true };
}
```

注意 `@Delete(":id")` 与已有的 `@Delete(":id/pending-messages/:messageId")` 不冲突（NestJS 路径前缀更具体的优先匹配，但**注册顺序也影响**，把更具体的放前面更安全 —— 现有顺序已经是更具体的在前）。

- [ ] **Step 3：typecheck**

```bash
pnpm --filter @meshbot/server-agent typecheck
```

Expected：退出码 0。

- [ ] **Step 4：手测**

启 server-agent：

```bash
pnpm dev:server-agent
```

另开终端：

```bash
# 创会话
curl -sX POST localhost:3100/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"content":"测试创会话"}' | jq .

# 拿出 sessionId 替换 <SID>，list 应该至少能看到这一条
curl -s localhost:3100/api/sessions | jq .

# pin
curl -sX PATCH localhost:3100/api/sessions/<SID> \
  -H 'Content-Type: application/json' \
  -d '{"pinned":true}' | jq .

# rename
curl -sX PATCH localhost:3100/api/sessions/<SID> \
  -H 'Content-Type: application/json' \
  -d '{"title":"重命名后"}' | jq .

# delete
curl -sX DELETE localhost:3100/api/sessions/<SID> | jq .
# 再 list 应无该条
curl -s localhost:3100/api/sessions | jq .
```

Expected：每步都返 envelope 包裹的 success: true 数据；list 排序正确；delete 后 list 没该条。

- [ ] **Step 5：commit**

```bash
git add apps/server-agent/src/dto/session.dto.ts \
        apps/server-agent/src/controllers/session.controller.ts
git commit -m "$(cat <<'EOF'
feat(session): GET /api/sessions + PATCH/:id + DELETE/:id 端点

POST/:id/messages 路径以下的 DELETE 不受影响（更具体的注册在前）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10：前端 REST 客户端

**Files:**
- Modify: `apps/web-agent/src/rest/session.ts`

- [ ] **Step 1：改 createSession + 加 list/patch/delete**

把 `apps/web-agent/src/rest/session.ts` 顶部 import 改为：

```ts
import type {
  DeletePendingResponse,
  HistoryResponse,
  PendingResponse,
  SessionListResponse,
  SessionSummary,
  CreateSessionResponse,
  SessionDeleteResponse,
} from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";
```

把 `createSession` 改为：

```ts
/**
 * 创建会话。返回完整 session 对象，前端用其 unshift 进 sessionsAtom，
 * 避免再发一次 list。
 */
export async function createSession(
  content: string,
): Promise<CreateSessionResponse> {
  const { data } = await apiClient.post<CreateSessionResponse>(
    "/api/sessions",
    { content },
  );
  return data;
}
```

文件末尾追加：

```ts
/** 列出全部会话（已排序）。 */
export async function listSessions(): Promise<SessionSummary[]> {
  const { data } = await apiClient.get<SessionListResponse>("/api/sessions");
  return data.sessions;
}

/** 更新会话 title / pinned。 */
export async function patchSession(
  id: string,
  patch: { title?: string; pinned?: boolean },
): Promise<SessionSummary> {
  const { data } = await apiClient.patch<SessionSummary>(
    `/api/sessions/${id}`,
    patch,
  );
  return data;
}

/** 删除整条会话（级联清后端数据）。 */
export async function deleteSession(
  id: string,
): Promise<SessionDeleteResponse> {
  const { data } = await apiClient.delete<SessionDeleteResponse>(
    `/api/sessions/${id}`,
  );
  return data;
}
```

- [ ] **Step 2：修复 createSession 老调用方**

编辑 `apps/web-agent/src/app/page.tsx`：把 `const sessionId = await createSession(msg);` 改为：

```ts
const { sessionId } = await createSession(msg);
```

（实际执行时如果 `addSessionAtom` 还没引入，先只改解构方式让 typecheck 过，Task 12 再加 atom 调用）

- [ ] **Step 3：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck
```

Expected：退出码 0。

- [ ] **Step 4：commit**

```bash
git add apps/web-agent/src/rest/session.ts apps/web-agent/src/app/page.tsx
git commit -m "$(cat <<'EOF'
feat(web-agent): rest 加 listSessions / patchSession / deleteSession

createSession 改返 { sessionId, session } 完整对象。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11：sessions atoms（Jotai）

**Files:**
- Create: `apps/web-agent/src/atoms/sessions.ts`

- [ ] **Step 1：实现 atoms**

新建 `apps/web-agent/src/atoms/sessions.ts`：

```ts
"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import { atom } from "jotai";
import {
  deleteSession as deleteSessionApi,
  listSessions,
  patchSession,
} from "@/rest/session";

export type SessionsStatus = "idle" | "loading" | "loaded" | "error";

/** 全局会话列表（已排序）。任何写都走 sortSessions 重排。 */
export const sessionsAtom = atom<SessionSummary[]>([]);

/** 首屏加载状态。loaded 后永不再回 loading；新增/改/删全走局部 patch。 */
export const sessionsStatusAtom = atom<SessionsStatus>("idle");

/** 派生：已固定。 */
export const pinnedSessionsAtom = atom((get) =>
  get(sessionsAtom).filter((s) => s.pinned),
);

/** 派生：未固定。 */
export const recentSessionsAtom = atom((get) =>
  get(sessionsAtom).filter((s) => !s.pinned),
);

/** 排序：pinned 优先；pinned 内 pinnedAt desc；其余 updatedAt desc。 */
function sortSessions(arr: SessionSummary[]): SessionSummary[] {
  return [...arr].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      // 都 pinned：pinnedAt 必非 null
      return (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "");
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** 首次加载（mount 时调）。已 loaded / loading 则 no-op。 */
export const loadSessionsAtom = atom(null, async (get, set) => {
  if (get(sessionsStatusAtom) !== "idle") return;
  set(sessionsStatusAtom, "loading");
  try {
    const arr = await listSessions();
    set(sessionsAtom, sortSessions(arr));
    set(sessionsStatusAtom, "loaded");
  } catch {
    set(sessionsStatusAtom, "error");
  }
});

/** 手动重试（错误态用）。无视当前 status，直接重拉。 */
export const reloadSessionsAtom = atom(null, async (_get, set) => {
  set(sessionsStatusAtom, "loading");
  try {
    const arr = await listSessions();
    set(sessionsAtom, sortSessions(arr));
    set(sessionsStatusAtom, "loaded");
  } catch {
    set(sessionsStatusAtom, "error");
  }
});

/** 新建会话后插入：直接 push + sort（push 比 unshift 更直观，反正都排）。 */
export const addSessionAtom = atom(
  null,
  (get, set, summary: SessionSummary) => {
    const arr = [...get(sessionsAtom), summary];
    set(sessionsAtom, sortSessions(arr));
  },
);

/**
 * 重命名（乐观）。空标题或与原值相同：直接 no-op 不发请求。
 * 失败回滚到原 title + 抛错给调用方（让 UI 弹 toast）。
 */
export const renameSessionAtom = atom(
  null,
  async (get, set, params: { id: string; title: string }) => {
    const arr = get(sessionsAtom);
    const idx = arr.findIndex((s) => s.id === params.id);
    if (idx < 0) return;
    const before = arr[idx];
    const trimmed = params.title.trim();
    if (!trimmed || trimmed === before.title) return;
    const next = [...arr];
    next[idx] = { ...before, title: trimmed };
    set(sessionsAtom, sortSessions(next));
    try {
      const updated = await patchSession(params.id, { title: trimmed });
      const after = get(sessionsAtom).map((s) =>
        s.id === params.id ? updated : s,
      );
      set(sessionsAtom, sortSessions(after));
    } catch (err) {
      const rollback = get(sessionsAtom).map((s) =>
        s.id === params.id ? before : s,
      );
      set(sessionsAtom, sortSessions(rollback));
      throw err;
    }
  },
);

/** Pin / unpin（乐观）。失败回滚。 */
export const togglePinAtom = atom(
  null,
  async (get, set, params: { id: string; pinned: boolean }) => {
    const arr = get(sessionsAtom);
    const idx = arr.findIndex((s) => s.id === params.id);
    if (idx < 0) return;
    const before = arr[idx];
    const next = [...arr];
    next[idx] = {
      ...before,
      pinned: params.pinned,
      pinnedAt: params.pinned ? new Date().toISOString() : null,
    };
    set(sessionsAtom, sortSessions(next));
    try {
      const updated = await patchSession(params.id, { pinned: params.pinned });
      const after = get(sessionsAtom).map((s) =>
        s.id === params.id ? updated : s,
      );
      set(sessionsAtom, sortSessions(after));
    } catch (err) {
      const rollback = get(sessionsAtom).map((s) =>
        s.id === params.id ? before : s,
      );
      set(sessionsAtom, sortSessions(rollback));
      throw err;
    }
  },
);

/** 删除（乐观）。失败回插原位。 */
export const deleteSessionAtom = atom(
  null,
  async (get, set, id: string) => {
    const arr = get(sessionsAtom);
    const target = arr.find((s) => s.id === id);
    if (!target) return;
    set(
      sessionsAtom,
      arr.filter((s) => s.id !== id),
    );
    try {
      await deleteSessionApi(id);
    } catch (err) {
      set(sessionsAtom, sortSessions([...get(sessionsAtom), target]));
      throw err;
    }
  },
);
```

- [ ] **Step 2：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck
```

Expected：退出码 0。

- [ ] **Step 3：commit**

```bash
git add apps/web-agent/src/atoms/sessions.ts
git commit -m "$(cat <<'EOF'
feat(web-agent): sessions atoms (load / add / rename / togglePin / delete)

Jotai 单 atom 维护全列表 + 乐观更新 + 客户端排序。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12：创会话流程接入 addSessionAtom

**Files:**
- Modify: `apps/web-agent/src/app/page.tsx`

- [ ] **Step 1：编辑**

在 `app/page.tsx` 顶部 import 加：

```ts
import { useSetAtom } from "jotai";
import { addSessionAtom } from "@/atoms/sessions";
```

在创会话流程里把 `await createSession(msg)` 的结果用上：

```ts
const addSession = useSetAtom(addSessionAtom);
// ...
const { sessionId, session } = await createSession(msg);
addSession(session);
router.push(`/session/${sessionId}`);
```

具体合并位置参考现有代码（约 `app/page.tsx:27` 那一处）。

- [ ] **Step 2：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck
```

Expected：退出码 0。

- [ ] **Step 3：commit**

```bash
git add apps/web-agent/src/app/page.tsx
git commit -m "$(cat <<'EOF'
feat(web-agent): 创会话成功后 addSessionAtom 局部插入

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13：i18n 文案

**Files:**
- Modify: `apps/web-agent/messages/zh.json`
- Modify: `apps/web-agent/messages/en.json`

- [ ] **Step 1：改 zh.json**

把 `appShell` 块替换为：

```json
"appShell": {
  "newSession": "新会话",
  "scheduled": "计划任务",
  "pinned": "已固定",
  "sessions": "会话",
  "logout": "退出",
  "promptPlaceholder": "描述一个任务或提出一个问题",
  "local": "本地",
  "modelBadge": "Flash · Medium",
  "sessionMenu": {
    "rename": "修改标题",
    "pin": "固定",
    "unpin": "取消固定",
    "delete": "删除"
  },
  "deleteConfirm": {
    "title": "删除会话「{title}」？",
    "description": "此会话内所有消息及记录将被永久删除，不可恢复。",
    "cancel": "取消",
    "confirm": "删除"
  },
  "loadFailed": "会话加载失败",
  "retry": "重试"
}
```

`appShell.dragToPin / recents / addMarketplacePlugin / respondToUserGreeting` 删掉（移除文件顶层重复的旧 key 时也一起删）。文件顶层（非 `appShell.` 命名空间）那一坨旧 key（`recents / dragToPin / addMarketplacePlugin / respondToUserGreeting`）保留还是删要看是否被其他地方引用。运行：

```bash
grep -rn "appShell\.dragToPin\|appShell\.recents\|appShell\.addMarketplacePlugin\|appShell\.respondToUserGreeting" apps/web-agent/src
```

无引用就删（i18n sync 脚本会校验，留着也只是 ORPHAN warning）。

- [ ] **Step 2：改 en.json**

把 `appShell` 块替换为（保持英文表达）：

```json
"appShell": {
  "newSession": "New session",
  "scheduled": "Scheduled",
  "pinned": "Pinned",
  "sessions": "Sessions",
  "logout": "Log out",
  "promptPlaceholder": "Describe a task or ask a question",
  "local": "Local",
  "modelBadge": "Flash · Medium",
  "sessionMenu": {
    "rename": "Rename",
    "pin": "Pin",
    "unpin": "Unpin",
    "delete": "Delete"
  },
  "deleteConfirm": {
    "title": "Delete session \"{title}\"?",
    "description": "All messages and records in this session will be permanently deleted.",
    "cancel": "Cancel",
    "confirm": "Delete"
  },
  "loadFailed": "Failed to load sessions",
  "retry": "Retry"
}
```

- [ ] **Step 3：跑 i18n 同步检查**

```bash
pnpm tsx scripts/sync-locales.ts -- --check
```

Expected：`Done (missing=0, asymmetric=0)`。ORPHAN warning（未使用 key）忽略 —— 实际清理在 Task 14 渲染组件用上后即不再 ORPHAN。

- [ ] **Step 4：commit**

```bash
git add apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "$(cat <<'EOF'
i18n(web-agent): appShell 文案改 sessions / 删 mockup 文案 / 加菜单与删除确认

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14：sidebar 组件 — Skeleton + DeleteDialog

**Files:**
- Create: `apps/web-agent/src/components/sidebar/session-list-skeleton.tsx`
- Create: `apps/web-agent/src/components/sidebar/session-delete-dialog.tsx`

- [ ] **Step 1：Skeleton**

新建 `session-list-skeleton.tsx`：

```tsx
"use client";

/**
 * 首屏骨架占位 —— 6 条灰底 pulse 方块。只在「会话」分组下用；
 * pinned 分组默认隐藏，不为它渲染骨架。
 */
export function SessionListSkeleton() {
  return (
    <div className="mt-1 space-y-0.5">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-7 w-full animate-pulse bg-foreground/5"
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2：DeleteDialog**

先确认 shadcn AlertDialog 是否已安装。

```bash
ls packages/design/src/components/ui/alert-dialog.tsx 2>&1
```

如果不存在，**先创建**（与现有 shadcn 组件位置一致；如果项目里 shadcn 在别的路径，按实际改）：

```tsx
// 略 —— 若不存在则按 shadcn 官方 alert-dialog 复制；若你的项目已有等价组件直接复用
```

**如果不存在 alert-dialog**，可以直接用 `<Dialog>`（项目通常有）或写一个最小版本。检查：

```bash
grep -rn "AlertDialog\|@meshbot/design.*Dialog" apps/web-agent/src packages/design/src 2>&1 | head -5
```

按实际 design 包结构 import。

如果当前 design 包**没有 AlertDialog**，写一个最小内联 dialog（不引入新依赖）：

新建 `session-delete-dialog.tsx`：

```tsx
"use client";

import { cn } from "@meshbot/design";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

interface Props {
  open: boolean;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 删除确认 dialog。固定居中遮罩 + 简单文案 + 两按钮。
 * 不引入新依赖：design 包当前的 AlertDialog 若可用应优先用之；这里先内联，
 * 后续统一对齐 design 包再替换。
 *
 * Esc 关闭；遮罩点击关闭。
 */
export function SessionDeleteDialog({
  open,
  title,
  onCancel,
  onConfirm,
}: Props) {
  const t = useTranslations("appShell.deleteConfirm");
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "flex w-[360px] flex-col gap-3 border border-border bg-background p-4 shadow-lg",
        )}
      >
        <div className="text-sm font-medium text-foreground">
          {t("title", { title })}
        </div>
        <div className="text-xs text-muted-foreground">
          {t("description")}
        </div>
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border border-border px-3 py-1 text-xs hover:bg-foreground/5"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="bg-destructive px-3 py-1 text-xs text-destructive-foreground hover:bg-destructive/90"
          >
            {t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck
```

Expected：退出码 0。

- [ ] **Step 4：commit**

```bash
git add apps/web-agent/src/components/sidebar/session-list-skeleton.tsx \
        apps/web-agent/src/components/sidebar/session-delete-dialog.tsx
git commit -m "$(cat <<'EOF'
feat(web-agent): sidebar SessionListSkeleton + SessionDeleteDialog

Skeleton 6 条 pulse 方块；DeleteDialog 内联遮罩+两按钮，Esc 关闭。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15：sidebar 组件 — SessionListItem（默认/编辑/激活 三态）

**Files:**
- Create: `apps/web-agent/src/components/sidebar/session-list-item.tsx`

- [ ] **Step 1：实现**

先确认 DropdownMenu 在 design 包里的路径：

```bash
grep -rn "DropdownMenu\b" packages/design/src 2>&1 | head -5
```

如果有，按实际路径 import；如果没有，**用 details/summary 或内联 popover**。多数 shadcn 项目里 DropdownMenu 应已存在。

新建 `session-list-item.tsx`：

```tsx
"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import { cn } from "@meshbot/design";
import {
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Pencil,
  Trash2,
} from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useSetAtom } from "jotai";
import {
  type KeyboardEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import {
  deleteSessionAtom,
  renameSessionAtom,
  togglePinAtom,
} from "@/atoms/sessions";
import { SessionDeleteDialog } from "./session-delete-dialog";

/**
 * 单条会话。三态：
 *  - 默认：图标 + 标题 + 三点（hover 显）
 *  - 编辑：图标 + Input（autofocus + 全选）；Enter/blur 保存、Esc 取消、IME 期 Enter 忽略
 *  - 激活：路由匹配则高亮（与 SidebarNavItem 一致色）
 *
 * 三点菜单：修改标题 / 固定·取消固定 / 删除。
 */
export function SessionListItem({ session }: { session: SessionSummary }) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("appShell.sessionMenu");
  const rename = useSetAtom(renameSessionAtom);
  const togglePin = useSetAtom(togglePinAtom);
  const removeSession = useSetAtom(deleteSessionAtom);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const active = pathname === `/session/${session.id}`;

  const startEditing = useCallback(() => {
    setMenuOpen(false);
    setEditing(true);
    // 等下一帧 input 渲染好再 focus + select
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const submitTitle = useCallback(
    async (value: string) => {
      setEditing(false);
      try {
        await rename({ id: session.id, title: value });
      } catch {
        // atom 内已回滚；后续可挂 toast
      }
    },
    [rename, session.id],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // IME composition 期 Enter 不算提交（与 ChatInput 一致约定）
      if (
        e.key === "Enter" &&
        !e.nativeEvent.isComposing &&
        e.keyCode !== 229
      ) {
        e.preventDefault();
        submitTitle((e.target as HTMLInputElement).value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditing(false);
      }
    },
    [submitTitle],
  );

  const handleDeleteConfirm = useCallback(async () => {
    setConfirmOpen(false);
    try {
      await removeSession(session.id);
      if (active) router.push("/");
    } catch {
      // atom 内已回滚
    }
  }, [removeSession, session.id, active, router]);

  return (
    <>
      <div
        className={cn(
          "group flex items-center gap-2 rounded-none px-2 py-1.5 text-[14px]",
          active
            ? "bg-accent text-white"
            : "text-foreground/80 hover:bg-accent hover:text-white",
        )}
      >
        <MessageSquare
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active
              ? "text-white"
              : "text-muted-foreground group-hover:text-white",
          )}
        />
        {editing ? (
          <input
            ref={inputRef}
            defaultValue={session.title}
            onKeyDown={handleKeyDown}
            onBlur={(e) => submitTitle(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-inherit outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => router.push(`/session/${session.id}`)}
            className="min-w-0 flex-1 truncate text-left"
            title={session.title}
          >
            {session.title}
          </button>
        )}
        {!editing && (
          <div className="relative">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className={cn(
                "opacity-0 transition-opacity group-hover:opacity-100",
                menuOpen && "opacity-100",
              )}
              aria-label="menu"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 top-5 z-10 min-w-[120px] border border-border bg-popover text-popover-foreground shadow"
              >
                <MenuItem icon={<Pencil className="h-3 w-3" />} onClick={startEditing}>
                  {t("rename")}
                </MenuItem>
                <MenuItem
                  icon={
                    session.pinned ? (
                      <PinOff className="h-3 w-3" />
                    ) : (
                      <Pin className="h-3 w-3" />
                    )
                  }
                  onClick={async () => {
                    setMenuOpen(false);
                    try {
                      await togglePin({
                        id: session.id,
                        pinned: !session.pinned,
                      });
                    } catch {
                      // 已回滚
                    }
                  }}
                >
                  {session.pinned ? t("unpin") : t("pin")}
                </MenuItem>
                <MenuItem
                  icon={<Trash2 className="h-3 w-3" />}
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmOpen(true);
                  }}
                  destructive
                >
                  {t("delete")}
                </MenuItem>
              </div>
            )}
          </div>
        )}
      </div>
      <SessionDeleteDialog
        open={confirmOpen}
        title={session.title}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}

function MenuItem({
  icon,
  children,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent hover:text-white",
        destructive && "text-destructive",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
```

- [ ] **Step 2：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck
```

Expected：退出码 0。

- [ ] **Step 3：commit**

```bash
git add apps/web-agent/src/components/sidebar/session-list-item.tsx
git commit -m "$(cat <<'EOF'
feat(web-agent): SessionListItem 三态（默认/编辑/激活）+ 三点菜单

IME 期 Enter 忽略，Esc 取消，blur 保存；菜单走 atom 乐观更新。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16：sidebar 组件 — SessionListSection + 接入 AppShell

**Files:**
- Create: `apps/web-agent/src/components/sidebar/session-list-section.tsx`
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`

- [ ] **Step 1：Section**

新建 `session-list-section.tsx`：

```tsx
"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import { SessionListItem } from "./session-list-item";

interface Props {
  title: string;
  sessions: SessionSummary[];
}

/** 侧边栏一段：标题 + 子项列表。 */
export function SessionListSection({ title, sessions }: Props) {
  return (
    <div className="mt-5">
      <div className="px-2 text-[12px] font-medium text-muted-foreground">
        {title}
      </div>
      <div className="mt-1 space-y-0.5 text-[14px]">
        {sessions.map((s) => (
          <SessionListItem key={s.id} session={s} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2：接入 AppShell**

编辑 `apps/web-agent/src/components/layouts/app-shell-layout.tsx`：

顶部 import 调整：

```ts
import { useAtomValue, useSetAtom } from "jotai";
import {
  pinnedSessionsAtom,
  recentSessionsAtom,
  sessionsStatusAtom,
  loadSessionsAtom,
  reloadSessionsAtom,
} from "@/atoms/sessions";
import { SessionListSection } from "@/components/sidebar/session-list-section";
import { SessionListSkeleton } from "@/components/sidebar/session-list-skeleton";
```

从 lucide-react 的 import 列表里删 `Grip` 和 `Pin`（不再用）。

把 component 函数内 `nav` 之后整段（「已固定」+ 「最近」两个写死 markup）替换为：

```tsx
const pinned = useAtomValue(pinnedSessionsAtom);
const recent = useAtomValue(recentSessionsAtom);
const status = useAtomValue(sessionsStatusAtom);
const loadSessions = useSetAtom(loadSessionsAtom);
const reload = useSetAtom(reloadSessionsAtom);

useEffect(() => {
  void loadSessions();
}, [loadSessions]);
```

（合并到已有 `useEffect` 也行；新增独立的更清晰）

把 nav 之后的两段静态 markup 替换为：

```tsx
{pinned.length > 0 && (
  <SessionListSection title={t("pinned")} sessions={pinned} />
)}

{status === "loading" ? (
  <div className="mt-5">
    <div className="px-2 text-[12px] font-medium text-muted-foreground">
      {t("sessions")}
    </div>
    <SessionListSkeleton />
  </div>
) : status === "error" ? (
  <div className="mt-5 px-2 text-xs text-destructive">
    {t("loadFailed")}{" "}
    <button
      type="button"
      onClick={() => void reload()}
      className="underline hover:text-destructive/80"
    >
      {t("retry")}
    </button>
  </div>
) : (
  <SessionListSection title={t("sessions")} sessions={recent} />
)}
```

- [ ] **Step 3：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck
```

Expected：退出码 0。

- [ ] **Step 4：commit**

```bash
git add apps/web-agent/src/components/sidebar/session-list-section.tsx \
        apps/web-agent/src/components/layouts/app-shell-layout.tsx
git commit -m "$(cat <<'EOF'
feat(web-agent): AppShell 接入 sessions atom + Section + Skeleton

删除静态 mockup「添加插件 / 回复用户问候」；首屏骨架；错误可重试。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 17：清理无用 i18n key + 手测全流程

**Files:**
- Modify: `apps/web-agent/messages/zh.json` / `en.json`（如有 ORPHAN）
- 无代码改动，仅手测

- [ ] **Step 1：扫描真正未引用的 i18n key**

```bash
pnpm tsx scripts/sync-locales.ts -- --check
```

观察 ORPHAN 列表里和 `appShell` / sidebar 相关的 key。

- [ ] **Step 2：删除确实未引用的 key**

针对 ORPHAN 报告里的 `appShell.dragToPin / appShell.recents / appShell.addMarketplacePlugin / appShell.respondToUserGreeting` 以及顶层重复的同名 key，从 `messages/zh.json` 和 `messages/en.json` 一并删除（**保留**仍被使用的 key）。再跑：

```bash
pnpm tsx scripts/sync-locales.ts -- --check
```

Expected：与 sidebar 改造相关的 ORPHAN 应清空。其他历史遗留 ORPHAN 不在本期范围。

- [ ] **Step 3：跑全部静态围栏**

```bash
pnpm check
```

Expected：6 个 check 全 0 finding。

- [ ] **Step 4：跑全部测试**

```bash
pnpm test
pnpm typecheck
```

Expected：全部 PASS。

- [ ] **Step 5：手测全流程**

启 server-agent + web-agent：

```bash
pnpm dev:server-agent &
pnpm dev:web-agent
```

浏览器访问 http://localhost:3001：

1. 首屏：侧边栏「会话」标题下出现 6 条骨架，~1s 后变为真实列表（若没有会话，则是空列表）；不显示「已固定」段。
2. 新建一个会话 → 跳转到 session 页 → 侧边栏列表立即出现一条。
3. 三点菜单 → 修改标题 → 输入新标题 + Enter → 列表立即变；服务端 PATCH 200。
4. 三点菜单 → 固定 → 该条出现在新的「已固定」段，且菜单变成「取消固定」。
5. 再固定一条 → 第二条排在第一条之上（最近固定的在上）。
6. 取消固定 → 回到「会话」段。
7. 三点菜单 → 删除 → 弹 Dialog → 取消：列表不变；再点 → 确认：列表立即移除该条；当前页是这条会话时跳 `/`。
8. 后端：`curl localhost:3100/api/sessions` 看与 UI 一致。
9. 强行 stop 后端、点删除：toast/atom 回滚后列表那条复现。

> **测试不通过的不要标 ✅** —— 把不通过的 case 写下来回到对应 task 修。

- [ ] **Step 6：commit（仅当 step 2 删了 i18n key）**

```bash
git add apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "$(cat <<'EOF'
chore(i18n): 清理侧边栏旧 mockup 的 ORPHAN key

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## 自检（Self-Review）

**1. Spec 覆盖：**
- 后端 entity + migration → Task 1 ✓
- types-agent schemas → Task 2 ✓
- listAllSorted → Task 3 ✓
- patch (title/pinned) → Task 4 ✓
- deleteBySession（llm_calls / session_messages）→ Task 5 ✓
- CheckpointerCleanupService → Task 6 ✓
- deleteSession 级联 + interrupt inflight → Task 7（service 层）+ Task 9（controller 层调 interrupt）✓
- createSession 返 SessionSummary → Task 8 ✓
- 4 个 REST 端点 → Task 9 ✓
- 前端 REST client → Task 10 ✓
- Jotai atoms + 排序 + 乐观更新 → Task 11 ✓
- 创会话流程接入 → Task 12 ✓
- i18n → Task 13 ✓
- 组件（skeleton/dialog/item/section）+ AppShell 接入 → Task 14/15/16 ✓
- 手测 → Task 17 ✓

**2. 占位扫描：**
- 无 TBD / TODO；测试 case 全列了具体 expectation；DropdownMenu / AlertDialog 不存在时给了 fallback 方案（内联）；i18n 替换文案完整。

**3. 类型一致性：**
- `SessionSummary.pinnedAt: string | null`（types-agent） ↔ `service.toSummary()` 输出 `s.pinnedAt ? s.pinnedAt.toISOString() : null` ↔ atom 排序按 string `localeCompare`。一致。
- `SessionPatchInput` ↔ `patchSession(id, patch)` ↔ `service.patch(id, input: { title?: string; pinned?: boolean })`。一致。
- `CheckpointerCleanupService.deleteThread(threadId)` ↔ `SessionService` 里调 `this.checkpointer.deleteThread(sessionId)`，名字一致。

无问题。

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-24-sidebar-session-list.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
