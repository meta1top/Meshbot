# session_messages 单调序号（seq）排序修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `session_messages` 增加按会话单调递增的 `seq` 列，作为唯一可靠排序键，根治"批量/定时任务注入消息刷新后时序错乱"。

**Architecture:** `seq` 在 INSERT 时用单条原子语句 `seq = (SELECT COALESCE(MAX(seq),0)+1 FROM session_messages WHERE session_id=?)` 赋值（避免并发写碰撞）；runner 流循环里把 `recordUser`/`recordAssistant` 从 fire-and-forget 改成顺序 `await`（保证同一批 human 按 emit 顺序拿到递增 seq）。所有读取（`listPage` / cursor 翻页）、`regenerateAfter` 的裁剪都改用 `seq`。纯后端改动，前端 / API 契约不变。

**Tech Stack:** NestJS + TypeORM + better-sqlite3；Jest；TypeORM migration（本地轨 SQLite）。

**根因回顾（why this works）：**
- 旧排序键 = `createdAt DESC, id DESC`。`createdAt` 在 `recordUser` 内 `await findOneBy` 之后才 `new Date()`，N 条 fire-and-forget 并发 → 同毫秒碰撞 → 退化成按**随机 UUID** 比较 → 顺序乱。
- `seq` 由**单条原子 INSERT 子查询**赋值（跨并发写者唯一、不碰撞），且 human 批次在流循环里**顺序 await** → emit 顺序 = 插入顺序 = seq 顺序。
- 实时态前端按 socket 到达顺序 append（= emit 顺序 = seq 顺序），刷新态按 seq 读 → 两者一致，不再分叉。

**作用域说明：** 只有 `user`/`assistant`/`system`(compaction) 行进时间线渲染；`tool` 行被过滤并按 `toolCallId` 折叠进 assistant，故其 seq 仅需"唯一 + 不碰撞"，无需精确 emit 顺序（其 `@OnEvent` 监听器与流循环因工具执行有秒级因果间隔，原子子查询足够）。旧数据 backfill 用现有 `(created_at, id)` 顺序，只能保持其当前展示序（历史真实序信息已丢失），但杜绝**未来**错乱。

---

## File Structure

- **Create** `apps/server-agent/src/migrations/1779900000000-AddSessionMessagesSeq.ts` — 加 `seq` 列 + 按会话 backfill + 新索引。
- **Modify** `apps/server-agent/src/entities/session-message.entity.ts` — 加 `seq` 列 + `@Index(["sessionId","seq"])`。
- **Modify** `apps/server-agent/src/services/session-message.service.ts` — 4 个 `record*` 改原子子查询赋 seq；`listPage` 改按 seq 排序 + cursor 按 seq；`deleteAfter` 改 seq 裁剪。
- **Modify** `apps/server-agent/src/services/session.service.ts` — `regenerateAfter` 用 `msg.seq` 裁剪 session_messages。
- **Modify** `apps/server-agent/src/services/runner.service.ts` — `recordUser`/`recordAssistant` 从 fire-and-forget 改顺序 `await`（含错误吞咽日志）。
- **Modify** `apps/server-agent/src/services/session-message.service.spec.ts` — seq 赋值/排序/回归/裁剪测试；`seed()` 写入显式 seq；compaction 占位单测改用 QueryBuilder mock。

---

### Task 1: 实体加 seq 列

**Files:**
- Modify: `apps/server-agent/src/entities/session-message.entity.ts:18-23`

- [ ] **Step 1: 加列与索引**

把现有 `@Index(["sessionId", "createdAt", "id"])` 下方追加第二个索引，并在 `id` 字段后加 `seq` 列：

```ts
@Entity("session_messages")
@Index(["sessionId", "createdAt", "id"])
@Index(["sessionId", "seq"])
export class SessionMessage {
  /** 与 checkpointer / pending_messages.id 对齐。 */
  @PrimaryColumn()
  id!: string;

  /**
   * 会话内单调递增序号（1-based）。唯一可靠排序键：
   * INSERT 时由 `(SELECT COALESCE(MAX(seq),0)+1 WHERE session_id=?)` 原子赋值。
   * createdAt 仅保留作活跃度统计 / 时间展示，不再用于排序（会同毫秒碰撞）。
   */
  @Column({ type: "integer", default: 0 })
  seq!: number;
```

（其余字段保持不变。）

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: PASS（实体新增列不破坏现有引用）。

- [ ] **Step 3: Commit**

```bash
git add apps/server-agent/src/entities/session-message.entity.ts
git commit -m "feat(server-agent): session_messages 加 seq 列与索引"
```

---

### Task 2: record* 原子赋 seq（TDD）

**Files:**
- Modify: `apps/server-agent/src/services/session-message.service.ts:76-161`
- Test: `apps/server-agent/src/services/session-message.service.spec.ts`

- [ ] **Step 1: 写失败测试 —— seq 递增 + 会话独立 + tool/assistant 也有 seq**

在 `describe("SessionMessageService", ...)` 内追加：

```ts
it("recordUser 按调用顺序分配会话内递增 seq（1,2,3）", async () => {
  await service.recordUser({ id: "u1", sessionId: "s1", content: "a" });
  await service.recordUser({ id: "u2", sessionId: "s1", content: "b" });
  await service.recordUser({ id: "u3", sessionId: "s1", content: "c" });
  const rows = await ds
    .getRepository(SessionMessage)
    .find({ where: { sessionId: "s1" }, order: { seq: "ASC" } });
  expect(rows.map((r) => [r.id, r.seq])).toEqual([
    ["u1", 1],
    ["u2", 2],
    ["u3", 3],
  ]);
});

it("seq 按 session 独立计数", async () => {
  await service.recordUser({ id: "a1", sessionId: "sA", content: "a" });
  await service.recordUser({ id: "b1", sessionId: "sB", content: "b" });
  await service.recordUser({ id: "a2", sessionId: "sA", content: "c" });
  const a = await ds.getRepository(SessionMessage).findOneBy({ id: "a2" });
  const b = await ds.getRepository(SessionMessage).findOneBy({ id: "b1" });
  expect(a?.seq).toBe(2);
  expect(b?.seq).toBe(1);
});

it("recordAssistant / recordToolResult 也分配 seq（接续 max+1）", async () => {
  await service.recordUser({ id: "u1", sessionId: "s1", content: "q" });
  await service.recordAssistant({
    id: "a1",
    sessionId: "s1",
    content: "ans",
    reasoning: null,
  });
  await service.recordToolResult({
    id: "tc1",
    sessionId: "s1",
    toolCallId: "tc1",
    content: "r",
  });
  const a = await ds.getRepository(SessionMessage).findOneBy({ id: "a1" });
  const t = await ds.getRepository(SessionMessage).findOneBy({ id: "tc1" });
  expect(a?.seq).toBe(2);
  expect(t?.seq).toBe(3);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- session-message.service.spec.ts -t "seq"`
Expected: FAIL（当前 seq 恒为 default 0）。

- [ ] **Step 3: 实现 —— 抽公共 insert helper，用 QueryBuilder 子查询赋 seq**

在 `SessionMessageService` 类内新增私有 helper，并把 4 个 `record*` 的 `this.repo.insert({...})` 全部替换为调用它。helper：

```ts
/**
 * 统一插入入口：seq 由单条原子 INSERT 子查询赋值，杜绝并发写碰撞。
 * 调用方负责幂等检查（findOneBy）。columns 不含 seq。
 */
private async insertWithSeq(
  row: Omit<Partial<SessionMessage>, "seq" | "createdAt">,
): Promise<void> {
  await this.repo
    .createQueryBuilder()
    .insert()
    .into(SessionMessage)
    .values({
      ...row,
      createdAt: () => "datetime('now')",
      // 原子：MAX(seq)+1 与本次 INSERT 同语句，SQLite 写锁内串行，唯一不碰撞
      seq: () =>
        "(SELECT COALESCE(MAX(seq), 0) + 1 FROM session_messages WHERE session_id = :sid)",
    })
    .setParameter("sid", row.sessionId)
    .execute();
}
```

> 注意：原 `recordUser`/`recordAssistant`/`recordToolResult` 用 `createdAt: new Date()`（毫秒精度）。改用 `datetime('now')`（秒精度）安全，因为排序已不依赖 createdAt。若想保毫秒可改 `setParameter("now", new Date().toISOString())` 传入；本计划用 `datetime('now')` 简洁。

把各方法体内 `await this.repo.insert({ ... createdAt: new Date() })` 改为去掉 `createdAt`、改调 `await this.insertWithSeq({ ... })`。例如 `recordUser`：

```ts
async recordUser(input: RecordUserInput): Promise<void> {
  const exists = await this.repo.findOneBy({ id: input.id });
  if (exists) return;
  await this.insertWithSeq({
    id: input.id,
    sessionId: input.sessionId,
    role: "user",
    content: input.content,
    reasoning: null,
    toolCalls: null,
    toolCallId: null,
  });
}
```

`recordAssistant`（保留 reasoning/toolCalls）、`recordToolResult`（保留 metadata 计算）、`recordCompactionPlaceholder`（保留 metadata JSON）同样改为 `await this.insertWithSeq({...})`，去掉各自的 `createdAt: new Date()`。同步更新方法上方 JSDoc（删掉"显式传 createdAt 毫秒精度"那段，改述 seq 不变量）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meshbot/server-agent test -- session-message.service.spec.ts -t "seq"`
Expected: PASS。

- [ ] **Step 5: 修 compaction 占位单测（mock 从 insert 改 QueryBuilder）**

`describe("SessionMessageService.recordCompactionPlaceholder", ...)` 当前 mock `repo.insert`。改成 mock QueryBuilder 链：

```ts
beforeEach(async () => {
  const exec = jest.fn().mockResolvedValue({});
  const qb = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    execute: exec,
  };
  repo = {
    findOneBy: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  } as unknown as jest.Mocked<Repository<SessionMessage>>;
  // 暴露给断言
  (repo as unknown as { __qb: typeof qb }).__qb = qb;
  const moduleRef = await Test.createTestingModule({
    providers: [
      SessionMessageService,
      { provide: getRepositoryToken(SessionMessage), useValue: repo },
    ],
  }).compile();
  service = moduleRef.get(SessionMessageService);
});
```

两个断言改为针对 `qb.values` 的入参：

```ts
it("插入一行 role=system + content=summary + metadata JSON", async () => {
  repo.findOneBy.mockResolvedValue(null);
  await service.recordCompactionPlaceholder({
    id: "comp-1",
    sessionId: "s1",
    summary: "用户问了 X，已尝试 Y",
    removedCount: 5,
    fromMessageId: "m1",
    toMessageId: "m5",
  });
  const qb = (repo as unknown as { __qb: { values: jest.Mock } }).__qb;
  expect(qb.values).toHaveBeenCalledTimes(1);
  const arg = qb.values.mock.calls[0][0] as Partial<SessionMessage>;
  expect(arg.id).toBe("comp-1");
  expect(arg.role).toBe("system");
  expect(arg.content).toBe("用户问了 X，已尝试 Y");
  const meta = JSON.parse(arg.metadata as string);
  expect(meta).toEqual({
    kind: "compaction",
    removedCount: 5,
    fromMessageId: "m1",
    toMessageId: "m5",
  });
});

it("id 已存在视为幂等成功，不重复 insert", async () => {
  repo.findOneBy.mockResolvedValue({ id: "comp-1" } as SessionMessage);
  await service.recordCompactionPlaceholder({
    id: "comp-1",
    sessionId: "s1",
    summary: "x",
    removedCount: 1,
    fromMessageId: "a",
    toMessageId: "b",
  });
  const qb = (repo as unknown as { __qb: { values: jest.Mock } }).__qb;
  expect(qb.values).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: 全 spec 跑通**

Run: `pnpm --filter @meshbot/server-agent test -- session-message.service.spec.ts`
Expected: PASS（注意：旧的 `seed()` 仍可能让 listPage 测试失败 → 由 Task 3 修复）。

- [ ] **Step 7: Commit**

```bash
git add apps/server-agent/src/services/session-message.service.ts apps/server-agent/src/services/session-message.service.spec.ts
git commit -m "feat(server-agent): record* 用原子子查询分配 seq"
```

---

### Task 3: listPage / deleteAfter 改按 seq（TDD，含回归测试）

**Files:**
- Modify: `apps/server-agent/src/services/session-message.service.ts:171-220,236-245`
- Test: `apps/server-agent/src/services/session-message.service.spec.ts`

- [ ] **Step 1: 改 seed() 写入显式 seq，并加回归测试**

把 spec 顶部的 `seed()` 改为按行序写入 `seq`（用 `offsetMs` 作为 createdAt，行下标+1 作 seq）：

```ts
async function seed(
  sessionId: string,
  rows: Array<{
    role: "user" | "assistant";
    content: string;
    offsetMs: number;
  }>,
): Promise<string[]> {
  const base = Date.now();
  const ids: string[] = [];
  let i = 0;
  for (const r of rows) {
    i += 1;
    const id = randomUUID();
    ids.push(id);
    await ds.getRepository(SessionMessage).insert({
      id,
      sessionId,
      role: r.role,
      content: r.content,
      reasoning: null,
      toolCalls: null,
      toolCallId: null,
      seq: i,
      createdAt: new Date(base + r.offsetMs),
    });
  }
  return ids;
}
```

新增**回归测试**（证明 bug 修复）：createdAt 全相同、UUID 顺序无关，listPage 仍按 seq 排：

```ts
it("回归：createdAt 相同也按 seq 稳定排序（修复批量注入时序错乱）", async () => {
  const same = new Date();
  const order = ["m1", "m2", "m3", "m4"];
  // 故意打乱物理插入顺序，但 seq 反映真实 emit 顺序
  for (const [physIdx, content] of [order[2], order[0], order[3], order[1]].entries()) {
    void physIdx;
    const seq = order.indexOf(content) + 1;
    await ds.getRepository(SessionMessage).insert({
      id: randomUUID(),
      sessionId: "s1",
      role: seq % 2 === 1 ? "user" : "assistant",
      content,
      reasoning: null,
      toolCalls: null,
      toolCallId: null,
      seq,
      createdAt: same,
    });
  }
  const res = await service.listPage("s1", { limit: 10 });
  expect(res.messages.map((m) => m.content)).toEqual(order);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- session-message.service.spec.ts -t "回归"`
Expected: FAIL（当前按 createdAt/id 排，结果非 m1..m4）。

- [ ] **Step 3: 实现 —— listPage 锚点/排序/round-up 全换 seq**

替换 `listPage` 方法体：

```ts
async listPage(
  sessionId: string,
  opts: { before?: string; limit: number },
): Promise<SessionMessagePage> {
  let anchorSeq: number | undefined;
  if (opts.before) {
    const anchor = await this.repo.findOneBy({ id: opts.before });
    if (!anchor || anchor.sessionId !== sessionId) {
      throw new NotFoundException(
        `SessionMessage ${opts.before} not found in session ${sessionId}`,
      );
    }
    anchorSeq = anchor.seq;
  }
  const rows = await this.repo.find({
    where: {
      sessionId,
      ...(anchorSeq !== undefined ? { seq: LessThan(anchorSeq) } : {}),
    },
    order: { seq: "DESC" },
    take: opts.limit + 1,
  });
  const hasMore = rows.length > opts.limit;
  let slice = hasMore ? rows.slice(0, opts.limit) : rows;
  slice.reverse();

  // Round up：把 slice 末尾紧跟的 role=tool 行一并捞回，避免 assistant 与其
  // tool result 被切到不同页（controller 按 toolCallId 折叠需同页）。
  if (slice.length > 0) {
    const lastSeq = slice[slice.length - 1].seq;
    const qb = this.repo
      .createQueryBuilder("m")
      .where("m.session_id = :sessionId", { sessionId })
      .andWhere("m.seq > :cutoff", { cutoff: lastSeq })
      .andWhere("m.role = :role", { role: "tool" })
      .orderBy("m.seq", "ASC");
    if (anchorSeq !== undefined) {
      qb.andWhere("m.seq < :anchor", { anchor: anchorSeq });
    }
    const trailingTools = await qb.getMany();
    slice = [...slice, ...trailingTools];
  }

  return { messages: slice, hasMore };
}
```

替换 `deleteAfter` 为 seq 裁剪（保留方法名以减少改动面，签名改 number）：

```ts
/**
 * 删某会话内 seq > cutoffSeq 的所有消息。供「重生成」剪 history 用。
 * cutoffSeq 本身保留（严格 >）。
 */
async deleteAfter(sessionId: string, cutoffSeq: number): Promise<void> {
  await this.repo.delete({
    sessionId,
    seq: MoreThan(cutoffSeq),
  });
}
```

`MoreThan` / `LessThan` 已在文件顶部 import（`import { LessThan, MoreThan, Repository } from "typeorm"`）。

- [ ] **Step 4: 修旧 deleteAfter 测试（createdAt → seq）**

`describe("findByIdOrFail / deleteAfter", ...)` 内两个 deleteAfter 测试改为传 `cutoffMsg.seq`：

```ts
it("deleteAfter 删 seq > cutoff 的消息，cutoff 本身保留", async () => {
  await service.recordUser({ id: "u1", sessionId: "s1", content: "A" });
  await service.recordAssistant({
    id: "a1",
    sessionId: "s1",
    content: "B",
    reasoning: null,
  });
  await service.recordUser({ id: "u2", sessionId: "s1", content: "C" });
  const cutoffMsg = await service.findByIdOrFail("u1");
  await service.deleteAfter("s1", cutoffMsg.seq);
  const page = await service.listPage("s1", { limit: 10 });
  expect(page.messages.map((m) => m.id)).toEqual(["u1"]);
});

it("deleteAfter 不影响其他 session", async () => {
  await service.recordUser({ id: "x1", sessionId: "s1", content: "x" });
  await service.recordUser({ id: "y1", sessionId: "s2", content: "y" });
  const cutoff = await service.findByIdOrFail("x1");
  await service.deleteAfter("s1", cutoff.seq);
  const p = await service.listPage("s2", { limit: 10 });
  expect(p.messages.map((m) => m.id)).toEqual(["y1"]);
});
```

（删掉这两个测试里的 `await new Promise((r)=>setTimeout(...))`，seq 不依赖时间间隔。）

- [ ] **Step 5: 跑全 spec 通过**

Run: `pnpm --filter @meshbot/server-agent test -- session-message.service.spec.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/server-agent/src/services/session-message.service.ts apps/server-agent/src/services/session-message.service.spec.ts
git commit -m "feat(server-agent): listPage/deleteAfter 改按 seq 排序与裁剪"
```

---

### Task 4: regenerateAfter 用 seq 裁剪

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts:340-354`
- Test: `apps/server-agent/src/services/session.service.spec.ts`（若已有 regenerateAfter 测试则改其断言；否则跳过新增，靠类型 + 既有覆盖）

- [ ] **Step 1: 改 regenerateAfter 调用**

把 `deleteAfter(sessionId, msg.createdAt)` 改为 `deleteAfter(sessionId, msg.seq)`；`llmCalls.deleteAfter` 保持 `msg.createdAt`（llm_calls 表无 seq，且 assistant 调用天然晚于该 user 消息，createdAt 裁剪正确）：

```ts
await this.sessionMessages.deleteAfter(sessionId, msg.seq);
await this.llmCalls.deleteAfter(sessionId, msg.createdAt);
await this.graph.cutMessagesAfter(sessionId, messageId);
```

- [ ] **Step 2: 类型检查 + 既有 session.service 测试**

Run: `pnpm --filter @meshbot/server-agent test -- session.service.spec.ts && pnpm --filter @meshbot/server-agent typecheck`
Expected: PASS（若有 regenerateAfter spec 断言 deleteAfter 入参为 createdAt，改成断言 `msg.seq`）。

- [ ] **Step 3: Commit**

```bash
git add apps/server-agent/src/services/session.service.ts apps/server-agent/src/services/session.service.spec.ts
git commit -m "feat(server-agent): regenerateAfter 用 seq 裁剪 session_messages"
```

---

### Task 5: runner 顺序 await record*（保证批内 emit 顺序）

**Files:**
- Modify: `apps/server-agent/src/services/runner.service.ts:417-426,498-512`

- [ ] **Step 1: human 写入改顺序 await**

把 `consumeRunStream` 里 human 分支的 fire-and-forget 改为顺序 await + try/catch 吞咽（保持"写库失败不杀 run"语义）：

```ts
// 双写 session_messages：顺序 await 保证同一批 human 按 emit 顺序拿到递增 seq
// （fire-and-forget 并发会让 seq 反映插入竞速顺序而非 emit 顺序）。写失败仅 log。
try {
  await this.sessionMessages.recordUser({
    id: event.messageId,
    sessionId,
    content,
  });
} catch (err) {
  this.logger.error(
    `session_messages.recordUser 失败 msg=${event.messageId}`,
    err,
  );
}
continue;
```

- [ ] **Step 2: assistant 写入改顺序 await**

`assistant_done` 分支同样改：

```ts
try {
  await this.sessionMessages.recordAssistant({
    id: event.messageId,
    sessionId,
    content: event.content,
    reasoning,
    toolCalls: toolCallsJson,
  });
} catch (err) {
  this.logger.error(
    `session_messages.recordAssistant 失败 msg=${event.messageId}`,
    err,
  );
}
continue;
```

- [ ] **Step 3: runner spec 通过**

Run: `pnpm --filter @meshbot/server-agent test -- runner.service.spec.ts`
Expected: PASS（mock 的 `recordUser`/`recordAssistant` 已是 async，await 安全）。

- [ ] **Step 4: Commit**

```bash
git add apps/server-agent/src/services/runner.service.ts
git commit -m "fix(server-agent): runner 顺序 await record* 保证批内 seq emit 顺序"
```

---

### Task 6: 迁移 —— 加列 + backfill + 索引

**Files:**
- Create: `apps/server-agent/src/migrations/1779900000000-AddSessionMessagesSeq.ts`
- Test: `apps/server-agent/src/migrations/add-session-messages-seq.spec.ts`（验证 backfill SQL 正确）

- [ ] **Step 1: 写 backfill SQL 的失败测试**

新建 spec，在内存 DB 上手建旧表结构、塞 legacy 行（无 seq）、跑 backfill UPDATE、断言每会话按 (created_at,id) 得到 1-based 连续 seq：

```ts
import { DataSource } from "typeorm";

describe("AddSessionMessagesSeq backfill SQL", () => {
  let ds: DataSource;
  beforeEach(async () => {
    ds = new DataSource({ type: "better-sqlite3", database: ":memory:" });
    await ds.initialize();
    await ds.query(`
      CREATE TABLE session_messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME NOT NULL
      )`);
    await ds.query(`ALTER TABLE session_messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`);
    const ins = (id: string, s: string, t: string) =>
      ds.query(
        `INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)`,
        [id, s, "user", id, t],
      );
    await ins("a", "s1", "2026-01-01 00:00:01");
    await ins("b", "s1", "2026-01-01 00:00:02");
    await ins("c", "s2", "2026-01-01 00:00:01");
  });
  afterEach(async () => {
    await ds.destroy();
  });

  it("按会话 (created_at,id) 赋 1-based 连续 seq", async () => {
    await ds.query(`
      UPDATE session_messages SET seq = (
        SELECT COUNT(*) FROM session_messages m2
        WHERE m2.session_id = session_messages.session_id
          AND (m2.created_at < session_messages.created_at
            OR (m2.created_at = session_messages.created_at AND m2.id <= session_messages.id))
      )`);
    const rows = await ds.query(
      `SELECT id, session_id, seq FROM session_messages ORDER BY session_id, seq`,
    );
    expect(rows).toEqual([
      { id: "a", session_id: "s1", seq: 1 },
      { id: "b", session_id: "s1", seq: 2 },
      { id: "c", session_id: "s2", seq: 1 },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meshbot/server-agent test -- add-session-messages-seq.spec.ts`
Expected: FAIL（spec 文件刚建，先确认能跑起来再写迁移；此处其实会 PASS —— 因为 SQL 内联在测试里。改为：先确认 spec PASS 证明 backfill SQL 正确，再据此写迁移文件）。

> 说明：本 Task 的 TDD 形态是"先用 spec 锁定 backfill SQL 的正确性，再把同一段 SQL 落进迁移文件"。Step 2 期望 PASS。

- [ ] **Step 3: 写迁移文件**

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * session_messages 加 seq 列 —— 会话内单调递增序号，唯一可靠排序键。
 *
 * 背景：旧排序键 createdAt 同毫秒碰撞后退化为随机 UUID 比较，批量/定时任务
 * 注入消息刷新后时序错乱。seq 由 INSERT 原子子查询赋值，杜绝并发碰撞。
 *
 * - 加列 NOT NULL DEFAULT 0
 * - backfill：按会话 (created_at, id) 升序赋 1-based 连续 seq（保持旧数据
 *   当前展示序；历史真实序信息已丢失，仅杜绝未来错乱）
 * - 复合索引 (session_id, seq) 支撑 ORDER BY seq 翻页
 */
export class AddSessionMessagesSeq1779900000000 implements MigrationInterface {
  name = "AddSessionMessagesSeq1779900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "session_messages" ADD COLUMN "seq" INTEGER NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(`
      UPDATE "session_messages" SET "seq" = (
        SELECT COUNT(*) FROM "session_messages" m2
        WHERE m2."session_id" = "session_messages"."session_id"
          AND (m2."created_at" < "session_messages"."created_at"
            OR (m2."created_at" = "session_messages"."created_at"
                AND m2."id" <= "session_messages"."id"))
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_session_messages_session_seq" ON "session_messages" ("session_id", "seq")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_session_messages_session_seq"`,
    );
    // SQLite 不支持 DROP COLUMN；保留 seq 列即可（参考既有 AddSessionsPinnedAt 注释）
  }
}
```

- [ ] **Step 4: 全 server-agent 测试 + 类型检查**

Run: `pnpm --filter @meshbot/server-agent test && pnpm --filter @meshbot/server-agent typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server-agent/src/migrations/1779900000000-AddSessionMessagesSeq.ts apps/server-agent/src/migrations/add-session-messages-seq.spec.ts
git commit -m "feat(server-agent): 迁移 session_messages 加 seq 列 + backfill + 索引"
```

---

### Task 7: 静态围栏 + 全量回归

- [ ] **Step 1: 围栏**

Run: `pnpm check:repo && pnpm check:tx && pnpm check:naming && pnpm check:lock-tx && pnpm check:dead`
Expected: 全 PASS。（`insertWithSeq` 是私有非事务方法，命名不命中 `*InDb/*InTx/persist*`，且无 `@Transactional` → check:naming 不应报；若报，按规则改名或确认豁免。）

- [ ] **Step 2: Biome**

Run: `pnpm lint && pnpm format`
Expected: 无 error。

- [ ] **Step 3: 全包构建 + 类型**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 4: 手动验收（可选）**

启动 `pnpm dev:server-agent`，让迁移自动跑；GET `/api/sessions/:id/history` 确认 messages 顺序稳定；连发多条 + 触发定时任务后刷新，确认刷新前后顺序一致。

---

## Self-Review

**Spec coverage：**
- 加 seq 列 → Task 1、Task 6。
- emit 顺序赋 seq → Task 2（原子子查询）+ Task 5（顺序 await）。
- 读按 seq → Task 3（listPage/cursor/round-up）。
- regenerate 裁剪按 seq → Task 4。
- 旧数据 backfill → Task 6。
- 前端：无需改（实时 append = emit 顺序 = seq 顺序；刷新按 seq 读）→ 计划开头已论证。

**Placeholder scan：** 无 TBD/TODO；每个代码步给出完整代码。

**Type consistency：**
- `insertWithSeq(row)` 在 Task 2 定义，Task 2 全部 record* 调用。
- `deleteAfter(sessionId, cutoffSeq: number)` 在 Task 3 改签名，Task 4 用 `msg.seq` 调用 —— 一致。
- `SessionMessage.seq:number` 在 Task 1 定义，Task 2/3/4/6 引用一致。
- cursor `before` 仍是 messageId，内部 resolve 成 `anchorSeq` —— API 契约不变。

**风险点：**
- `createdAt` 改用 `datetime('now')`（秒精度）：仅影响 activitySince 的时间分桶精度（本就按天/小时聚合，无影响）；排序已不依赖它。
- backfill O(n²) 相关子查询：本地 SQLite 历史规模可接受。
