# 计划任务（Schedule Tasks）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 cron + one-shot 计划任务：用户 / agent 创建 → 持久化到 SQLite + @nestjs/schedule 动态注册 → 到点投递为 user 消息回原会话 → `/schedule` 页可看 / 启停 / 删。

**Architecture:** 后端 `ScheduleService`（CRUD + SchedulerRegistry 同步）+ `ScheduleExecutor`（bootstrap reload + fire 投递）+ REST controller；libs/agent 用 DI token `SCHEDULE_TOOLS_PORT` 解耦，3 个 builtin tool 通过 port 调 ScheduleService；前端 `/schedule` 重写为列表 + inline 新建表单。

**Tech Stack:** NestJS、`@nestjs/schedule`、`cron-parser`（校验 + nextFireAt 计算）、`cronstrue`（cron → 人话）、TypeORM(SQLite)、Zod(`@meshbot/types-agent`)、Next.js + next-intl。

---

## 文件结构

**Spec ref：** `docs/superpowers/specs/2026-05-28-schedule-tasks-design.md`

### 后端

| 路径 | 责任 |
|---|---|
| `libs/types-agent/src/schedule.ts`（新） | 共享 schema：CronJob / CreateCronJobInput / PatchCronJob / CronJobListResponse |
| `apps/server-agent/src/entities/cron-job.entity.ts`（新） | Entity |
| `apps/server-agent/src/services/schedule.service.ts`（新） | CRUD + 与 SchedulerRegistry 同步；归属 CronJob 唯一 Repo 注入 |
| `apps/server-agent/src/services/schedule-executor.service.ts`（新） | bootstrap reload + fire(jobId) 投递 |
| `apps/server-agent/src/controllers/cron-job.controller.ts`（新） | REST endpoints |
| `apps/server-agent/src/dto/cron-job.dto.ts`（新） | DTO |
| `apps/server-agent/src/services/session.service.ts`（改） | deleteSession 级联调 ScheduleService.deleteBySession |
| `apps/server-agent/src/session.module.ts`（改） | 注册新 service / controller / `SCHEDULE_TOOLS_PORT` provider |
| `apps/server-agent/src/app.module.ts`（改） | 全局 `ScheduleModule.forRoot()` |

### Agent 工具

| 路径 | 责任 |
|---|---|
| `libs/agent/src/tools/schedule-tools.port.ts`（新） | `SCHEDULE_TOOLS_PORT` token + `ScheduleToolsPort` 接口 |
| `libs/agent/src/tools/builtins/schedule-create.tool.ts`（新） | 创建任务，绑定 ctx.sessionId |
| `libs/agent/src/tools/builtins/schedule-list.tool.ts`（新） | 列出当前 session 任务 |
| `libs/agent/src/tools/builtins/schedule-delete.tool.ts`（新） | 删除任务（越权校验） |
| `libs/agent/src/tools/builtins/date.tool.ts`（改） | timezone 改 optional + 默认 OS |
| `libs/agent/src/agent.module.ts`（改） | 注册 3 个新 tool |

### 前端

| 路径 | 责任 |
|---|---|
| `apps/web-agent/src/rest/cron-jobs.ts`（新） | REST helpers：list / create / patch / delete |
| `apps/web-agent/src/rest/index.ts`（改） | re-export |
| `apps/web-agent/src/app/schedule/page.tsx`（改） | 列表 + 「新建」按钮 + inline 表单 |
| `apps/web-agent/src/components/schedule/cron-job-card.tsx`（新） | 单条卡片 |
| `apps/web-agent/src/components/schedule/cron-job-form.tsx`（新） | 新建 inline 表单 |
| `apps/web-agent/messages/zh.json` + `en.json`（改） | `schedule.*` keys |

---

## Task 1：装 deps + 全局 ScheduleModule

**Files:**
- Modify: `apps/server-agent/package.json`
- Modify: `apps/web-agent/package.json`
- Modify: `apps/server-agent/src/app.module.ts`

- [ ] **Step 1：装 server-agent 依赖**

```bash
pnpm --filter @meshbot/server-agent add @nestjs/schedule cron-parser
```

- [ ] **Step 2：装 web-agent 依赖**

```bash
pnpm --filter @meshbot/web-agent add cronstrue
```

- [ ] **Step 3：在 app.module 注册 ScheduleModule**

`apps/server-agent/src/app.module.ts` 顶部 import 加：

```ts
import { ScheduleModule } from "@nestjs/schedule";
```

`imports:` 数组里 `EventEmitterModule.forRoot()` 之后加 `ScheduleModule.forRoot()`。

- [ ] **Step 4：typecheck**

```bash
pnpm --filter @meshbot/server-agent typecheck && pnpm --filter @meshbot/web-agent typecheck
```

Expected：exit 0。

- [ ] **Step 5：Commit**

```bash
git add apps/server-agent/package.json apps/web-agent/package.json pnpm-lock.yaml apps/server-agent/src/app.module.ts
git commit -m "$(cat <<'EOF'
chore: 装计划任务相关依赖 + 全局 ScheduleModule

@nestjs/schedule + cron-parser（server-agent）；cronstrue（web-agent）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2：types-agent schedule schema

**Files:**
- Create: `libs/types-agent/src/schedule.ts`
- Modify: `libs/types-agent/src/index.ts`

- [ ] **Step 1：写 schema**

新建 `libs/types-agent/src/schedule.ts`：

```ts
import { z } from "zod";

/** 任务类型：cron 重复 / once 一次性。 */
export const CronJobKindSchema = z.enum(["cron", "once"]);
export type CronJobKind = z.infer<typeof CronJobKindSchema>;

/** POST /api/cron-jobs 入参。 */
export const CreateCronJobSchema = z
  .object({
    sessionId: z.string().min(1),
    title: z.string().min(1).max(200),
    prompt: z.string().min(1),
    kind: CronJobKindSchema,
    cronExpr: z.string().optional(),
    timezone: z.string().optional(),
    runAt: z.string().datetime().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "cron" && !v.cronExpr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cronExpr"],
        message: "kind=cron 必须传 cronExpr",
      });
    }
    if (v.kind === "once" && !v.runAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runAt"],
        message: "kind=once 必须传 runAt",
      });
    }
  });
export type CreateCronJobInput = z.infer<typeof CreateCronJobSchema>;

/** PATCH /api/cron-jobs/:id 入参。 */
export const PatchCronJobSchema = z
  .object({
    enabled: z.boolean().optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .refine((d) => d.enabled !== undefined || d.title !== undefined, {
    message: "至少传 enabled 或 title 之一",
  });
export type PatchCronJobInput = z.infer<typeof PatchCronJobSchema>;

/** 单条 CronJob 对外形态。 */
export const CronJobSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  title: z.string(),
  prompt: z.string(),
  kind: CronJobKindSchema,
  cronExpr: z.string().nullable(),
  timezone: z.string().nullable(),
  runAt: z.string().datetime().nullable(),
  enabled: z.boolean(),
  lastFiredAt: z.string().datetime().nullable(),
  nextFireAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type CronJobDto = z.infer<typeof CronJobSchema>;

/** GET /api/cron-jobs 出参。 */
export const CronJobListResponseSchema = z.object({
  jobs: z.array(CronJobSchema),
});
export type CronJobListResponse = z.infer<typeof CronJobListResponseSchema>;
```

- [ ] **Step 2：barrel re-export**

`libs/types-agent/src/index.ts` 末尾追加：

```ts
export * from "./schedule";
```

- [ ] **Step 3：写测试**

新建 `libs/types-agent/src/schedule.spec.ts`：

```ts
import {
  CreateCronJobSchema,
  CronJobListResponseSchema,
  PatchCronJobSchema,
} from "./schedule";

describe("schedule schemas", () => {
  it("CreateCronJobSchema：kind=cron 缺 cronExpr → 报错", () => {
    const r = CreateCronJobSchema.safeParse({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
    });
    expect(r.success).toBe(false);
  });

  it("CreateCronJobSchema：kind=once 缺 runAt → 报错", () => {
    const r = CreateCronJobSchema.safeParse({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "once",
    });
    expect(r.success).toBe(false);
  });

  it("CreateCronJobSchema：cron 合法", () => {
    const r = CreateCronJobSchema.safeParse({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "Asia/Shanghai",
    });
    expect(r.success).toBe(true);
  });

  it("PatchCronJobSchema：全空 → 报错", () => {
    expect(PatchCronJobSchema.safeParse({}).success).toBe(false);
  });

  it("CronJobListResponseSchema：空列表合法", () => {
    expect(
      CronJobListResponseSchema.safeParse({ jobs: [] }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 4：跑测试 + typecheck**

```bash
pnpm jest libs/types-agent/src/schedule.spec.ts 2>&1 | tail -5
pnpm --filter @meshbot/types-agent typecheck
```

Expected：5 passed；typecheck exit 0。

- [ ] **Step 5：Commit**

```bash
git add libs/types-agent/src/schedule.ts libs/types-agent/src/schedule.spec.ts libs/types-agent/src/index.ts
git commit -m "$(cat <<'EOF'
feat(types-agent): 计划任务 schema（CronJob / Create / Patch / List）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3：CronJob entity + ScheduleService CRUD（不含 registry sync）

**Files:**
- Create: `apps/server-agent/src/entities/cron-job.entity.ts`
- Create: `apps/server-agent/src/services/schedule.service.ts`
- Create: `apps/server-agent/src/services/schedule.service.spec.ts`

> 本 task 只写「纯数据层」CRUD；与 SchedulerRegistry 的同步在 Task 5 接入（避免单 task 太大）。

- [ ] **Step 1：写 entity**

新建 `apps/server-agent/src/entities/cron-job.entity.ts`：

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from "typeorm";

/** 计划任务记录。本地 SQLite，逻辑外键无 DB 约束。 */
@Entity("cron_jobs")
export class CronJob {
  @PrimaryColumn() id!: string;

  @Column({ name: "session_id" }) sessionId!: string;

  @Column({ type: "varchar" }) kind!: "cron" | "once";

  @Column({ name: "cron_expr", type: "varchar", nullable: true })
  cronExpr!: string | null;

  @Column({ type: "varchar", nullable: true })
  timezone!: string | null;

  @Column({ name: "run_at", type: "datetime", nullable: true })
  runAt!: Date | null;

  @Column({ type: "text" }) prompt!: string;
  @Column({ type: "varchar", length: 200 }) title!: string;

  @Column({ type: "boolean", default: true }) enabled!: boolean;

  @Column({ name: "last_fired_at", type: "datetime", nullable: true })
  lastFiredAt!: Date | null;

  @Column({ name: "next_fire_at", type: "datetime", nullable: true })
  nextFireAt!: Date | null;

  @CreateDateColumn({ name: "created_at" }) createdAt!: Date;
}
```

- [ ] **Step 2：写失败测试**

新建 `apps/server-agent/src/services/schedule.service.spec.ts`：

```ts
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { CronJob } from "../entities/cron-job.entity";
import { ScheduleService } from "./schedule.service";

describe("ScheduleService CRUD", () => {
  let ds: DataSource;
  let svc: ScheduleService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [CronJob],
      synchronize: true,
    });
    await ds.initialize();
    svc = new ScheduleService(ds.getRepository(CronJob));
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("create(cron) 落库 + 算 nextFireAt", async () => {
    const job = await svc.create({
      sessionId: "s1",
      title: "morning",
      prompt: "good morning",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "Asia/Shanghai",
    });
    expect(job.id).toBeTruthy();
    expect(job.nextFireAt).toBeInstanceOf(Date);
    expect(job.enabled).toBe(true);
  });

  it("create(once) 落库 + nextFireAt = runAt", async () => {
    const runAt = new Date(Date.now() + 60_000);
    const job = await svc.create({
      sessionId: "s1",
      title: "later",
      prompt: "hi",
      kind: "once",
      runAt: runAt.toISOString(),
    });
    expect(job.runAt?.getTime()).toBe(runAt.getTime());
    expect(job.nextFireAt?.getTime()).toBe(runAt.getTime());
  });

  it("list 默认按 createdAt desc；按 sessionId 过滤", async () => {
    await svc.create({
      sessionId: "sA",
      title: "a",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    await svc.create({
      sessionId: "sB",
      title: "b",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 8 * * *",
      timezone: "UTC",
    });
    const all = await svc.list();
    expect(all).toHaveLength(2);
    const onlyA = await svc.list({ sessionId: "sA" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].sessionId).toBe("sA");
  });

  it("findById 不存在 → NotFound", async () => {
    await expect(svc.findById(randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("setEnabled 翻 enabled 字段", async () => {
    const job = await svc.create({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    const updated = await svc.setEnabled(job.id, false);
    expect(updated.enabled).toBe(false);
  });

  it("delete 删除一行", async () => {
    const job = await svc.create({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    await svc.delete(job.id);
    await expect(svc.findById(job.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("deleteBySession 删该 session 全部", async () => {
    await svc.create({
      sessionId: "sA",
      title: "a",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    await svc.create({
      sessionId: "sB",
      title: "b",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 8 * * *",
      timezone: "UTC",
    });
    await svc.deleteBySession("sA");
    expect(await svc.list()).toHaveLength(1);
  });

  it("markFired 更新 lastFiredAt + nextFireAt + 可选 enabled", async () => {
    const job = await svc.create({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "once",
      runAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const now = new Date();
    await svc.markFired(job.id, { lastFiredAt: now, enabled: false });
    const after = await svc.findById(job.id);
    expect(after.enabled).toBe(false);
    expect(after.lastFiredAt?.getTime()).toBe(now.getTime());
  });
});
```

- [ ] **Step 3：跑测试看失败**

```bash
pnpm jest apps/server-agent/src/services/schedule.service.spec.ts 2>&1 | tail -10
```

Expected：FAIL（ScheduleService 不存在 / 构造签名不匹配）。

- [ ] **Step 4：写实现**

新建 `apps/server-agent/src/services/schedule.service.ts`：

```ts
import { randomUUID } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import cronParser from "cron-parser";
import { Repository } from "typeorm";
import type { CreateCronJobInput } from "@meshbot/types-agent";
import { CronJob } from "../entities/cron-job.entity";

/** ScheduleService CRUD —— SchedulerRegistry 同步在 ScheduleExecutor 接入。 */
@Injectable()
export class ScheduleService {
  constructor(
    @InjectRepository(CronJob)
    private readonly repo: Repository<CronJob>,
  ) {}

  /** 计算下次触发时刻（cron / once 通用入口）。 */
  static computeNextFireAt(
    input: Pick<CreateCronJobInput, "kind" | "cronExpr" | "timezone" | "runAt">,
  ): Date {
    if (input.kind === "once") {
      return new Date(input.runAt as string);
    }
    return cronParser
      .parseExpression(input.cronExpr as string, {
        tz: input.timezone ?? undefined,
      })
      .next()
      .toDate();
  }

  async create(input: CreateCronJobInput): Promise<CronJob> {
    const id = randomUUID();
    const nextFireAt = ScheduleService.computeNextFireAt(input);
    const entity = this.repo.create({
      id,
      sessionId: input.sessionId,
      title: input.title,
      prompt: input.prompt,
      kind: input.kind,
      cronExpr: input.cronExpr ?? null,
      timezone: input.timezone ?? null,
      runAt: input.runAt ? new Date(input.runAt) : null,
      enabled: true,
      lastFiredAt: null,
      nextFireAt,
    });
    await this.repo.save(entity);
    return entity;
  }

  list(opts?: { sessionId?: string }): Promise<CronJob[]> {
    return this.repo.find({
      where: opts?.sessionId ? { sessionId: opts.sessionId } : {},
      order: { createdAt: "DESC" },
    });
  }

  async findById(id: string): Promise<CronJob> {
    const row = await this.repo.findOneBy({ id });
    if (!row) throw new NotFoundException(`CronJob ${id} 不存在`);
    return row;
  }

  async setEnabled(id: string, enabled: boolean): Promise<CronJob> {
    const row = await this.findById(id);
    row.enabled = enabled;
    await this.repo.save(row);
    return row;
  }

  async setTitle(id: string, title: string): Promise<CronJob> {
    const row = await this.findById(id);
    row.title = title;
    await this.repo.save(row);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete({ id });
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.repo.delete({ sessionId });
  }

  async markFired(
    id: string,
    patch: { lastFiredAt: Date; nextFireAt?: Date | null; enabled?: boolean },
  ): Promise<void> {
    await this.repo.update({ id }, patch);
  }
}
```

- [ ] **Step 5：跑测试看通过**

```bash
pnpm jest apps/server-agent/src/services/schedule.service.spec.ts 2>&1 | tail -8
```

Expected：8 passed。

- [ ] **Step 6：Commit**

```bash
git add apps/server-agent/src/entities/cron-job.entity.ts \
        apps/server-agent/src/services/schedule.service.ts \
        apps/server-agent/src/services/schedule.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(server-agent): CronJob entity + ScheduleService CRUD

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4：ScheduleExecutor + bootstrap reload + fire 投递

**Files:**
- Create: `apps/server-agent/src/services/schedule-executor.service.ts`
- Create: `apps/server-agent/src/services/schedule-executor.service.spec.ts`

- [ ] **Step 1：写失败测试**

新建 `apps/server-agent/src/services/schedule-executor.service.spec.ts`：

```ts
import { randomUUID } from "node:crypto";
import { SchedulerRegistry } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { CronJob } from "../entities/cron-job.entity";
import { ScheduleExecutor } from "./schedule-executor.service";
import { ScheduleService } from "./schedule.service";

function fakeSessions(opts?: { missing?: boolean }) {
  return {
    appendMessage: jest.fn().mockResolvedValue({ messageId: "m1", queued: true }),
    findOrNull: jest
      .fn()
      .mockResolvedValue(opts?.missing ? null : { id: "s1" }),
  };
}
function fakeRunner() {
  return { kick: jest.fn() };
}

describe("ScheduleExecutor.fire", () => {
  let ds: DataSource;
  let schedule: ScheduleService;
  let executor: ScheduleExecutor;
  let registry: SchedulerRegistry;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [CronJob],
      synchronize: true,
    });
    await ds.initialize();
    schedule = new ScheduleService(ds.getRepository(CronJob));
    registry = new SchedulerRegistry();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("fire(once)：投递 + disable + 写 lastFiredAt", async () => {
    const sessions = fakeSessions();
    const runner = fakeRunner();
    executor = new ScheduleExecutor(
      schedule,
      registry,
      sessions as never,
      runner as never,
    );
    const job = await schedule.create({
      sessionId: "s1",
      title: "t",
      prompt: "do thing",
      kind: "once",
      runAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await executor.fire(job.id);
    expect(sessions.appendMessage).toHaveBeenCalledWith("s1", {
      messageId: expect.any(String),
      content: "do thing",
    });
    expect(runner.kick).toHaveBeenCalledWith("s1");
    const after = await schedule.findById(job.id);
    expect(after.enabled).toBe(false);
    expect(after.lastFiredAt).toBeTruthy();
  });

  it("fire(cron)：投递后重算 nextFireAt，保持 enabled", async () => {
    const sessions = fakeSessions();
    const runner = fakeRunner();
    executor = new ScheduleExecutor(
      schedule,
      registry,
      sessions as never,
      runner as never,
    );
    const job = await schedule.create({
      sessionId: "s1",
      title: "t",
      prompt: "hi",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    const oldNext = job.nextFireAt!;
    await executor.fire(job.id);
    const after = await schedule.findById(job.id);
    expect(after.enabled).toBe(true);
    expect(after.lastFiredAt).toBeTruthy();
    expect(after.nextFireAt!.getTime()).toBeGreaterThanOrEqual(oldNext.getTime());
  });

  it("fire：session 已删 → disable，不投递", async () => {
    const sessions = fakeSessions({ missing: true });
    const runner = fakeRunner();
    executor = new ScheduleExecutor(
      schedule,
      registry,
      sessions as never,
      runner as never,
    );
    const job = await schedule.create({
      sessionId: "ghost",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    await executor.fire(job.id);
    expect(sessions.appendMessage).not.toHaveBeenCalled();
    expect(runner.kick).not.toHaveBeenCalled();
    const after = await schedule.findById(job.id);
    expect(after.enabled).toBe(false);
  });

  it("fire：job 已 disable → 直接 return", async () => {
    const sessions = fakeSessions();
    const runner = fakeRunner();
    executor = new ScheduleExecutor(
      schedule,
      registry,
      sessions as never,
      runner as never,
    );
    const job = await schedule.create({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    await schedule.setEnabled(job.id, false);
    await executor.fire(job.id);
    expect(sessions.appendMessage).not.toHaveBeenCalled();
  });

  it("bootstrap reload：将所有 enabled cron 注册到 registry；过期 once 自动 disable", async () => {
    const sessions = fakeSessions();
    const runner = fakeRunner();
    executor = new ScheduleExecutor(
      schedule,
      registry,
      sessions as never,
      runner as never,
    );
    const cronJob = await schedule.create({
      sessionId: "s1",
      title: "future-cron",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    const expired = await schedule.create({
      sessionId: "s1",
      title: "expired-once",
      prompt: "p",
      kind: "once",
      runAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await executor.onApplicationBootstrap();
    expect(registry.getCronJobs().has(cronJob.id)).toBe(true);
    const expiredAfter = await schedule.findById(expired.id);
    expect(expiredAfter.enabled).toBe(false);
  });
});
```

- [ ] **Step 2：跑测试看失败**

```bash
pnpm jest apps/server-agent/src/services/schedule-executor.service.spec.ts 2>&1 | tail -10
```

Expected：FAIL（ScheduleExecutor 不存在）。

- [ ] **Step 3：写实现**

新建 `apps/server-agent/src/services/schedule-executor.service.ts`：

```ts
import { randomUUID } from "node:crypto";
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob as CronJobLib } from "cron";
import cronParser from "cron-parser";
import { RunnerService } from "./runner.service";
import { ScheduleService } from "./schedule.service";
import { SessionService } from "./session.service";

/** 计划任务调度执行器：bootstrap reload + 单次 fire 投递。 */
@Injectable()
export class ScheduleExecutor implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduleExecutor.name);

  constructor(
    private readonly schedule: ScheduleService,
    private readonly registry: SchedulerRegistry,
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
  ) {}

  /** 启动时把所有 enabled job 注册到 SchedulerRegistry；过期 once 自动 disable。 */
  async onApplicationBootstrap(): Promise<void> {
    const all = await this.schedule.list();
    for (const job of all) {
      if (!job.enabled) continue;
      this.register(job);
    }
  }

  /** 给 ScheduleService 在创建 / 启用时调用，注册一条调度。 */
  register(job: {
    id: string;
    kind: "cron" | "once";
    cronExpr: string | null;
    timezone: string | null;
    runAt: Date | null;
  }): void {
    if (job.kind === "cron") {
      const cronJob = new CronJobLib(
        job.cronExpr as string,
        () => {
          void this.fire(job.id).catch((err) =>
            this.logger.error(`fire cron ${job.id} 失败`, err),
          );
        },
        null,
        true,
        job.timezone ?? undefined,
      );
      this.registry.addCronJob(job.id, cronJob);
      return;
    }
    const ms = (job.runAt as Date).getTime() - Date.now();
    if (ms <= 0) {
      // 错过的 one-shot：丢弃 + disable
      void this.schedule
        .setEnabled(job.id, false)
        .catch((err) => this.logger.error(`disable expired ${job.id}`, err));
      return;
    }
    const timeout = setTimeout(() => {
      void this.fire(job.id).catch((err) =>
        this.logger.error(`fire once ${job.id} 失败`, err),
      );
    }, ms);
    this.registry.addTimeout(job.id, timeout);
  }

  /** 反注册一条调度（kind 不确定时两边都尝试）。 */
  deregister(jobId: string): void {
    if (this.registry.getCronJobs().has(jobId)) {
      this.registry.deleteCronJob(jobId);
    }
    if (this.registry.getTimeouts().includes(jobId)) {
      this.registry.deleteTimeout(jobId);
    }
  }

  /** 到点触发：投递 user 消息 + kick runner + 更新触发记录。 */
  async fire(jobId: string): Promise<void> {
    const job = await this.schedule.findById(jobId);
    if (!job.enabled) return;

    const session = await this.sessions.findOrNull(job.sessionId);
    if (!session) {
      this.logger.warn(
        `fire ${jobId}：session ${job.sessionId} 已删，disable 该任务`,
      );
      await this.schedule.setEnabled(jobId, false);
      this.deregister(jobId);
      return;
    }

    await this.sessions.appendMessage(job.sessionId, {
      messageId: randomUUID(),
      content: job.prompt,
    });
    this.runner.kick(job.sessionId);

    if (job.kind === "once") {
      await this.schedule.markFired(jobId, {
        lastFiredAt: new Date(),
        enabled: false,
      });
      this.deregister(jobId);
      return;
    }
    const next = cronParser
      .parseExpression(job.cronExpr as string, {
        tz: job.timezone ?? undefined,
      })
      .next()
      .toDate();
    await this.schedule.markFired(jobId, {
      lastFiredAt: new Date(),
      nextFireAt: next,
    });
  }
}
```

注意：需要 `SessionService.findOrNull(id)` 方法（返 `Session | null`）—— 若不存在则在下一 step 补。

- [ ] **Step 4：补 SessionService.findOrNull（如不存在）**

```bash
grep -n "findOrNull" apps/server-agent/src/services/session.service.ts
```

若无，加：

```ts
  /** 找会话，不存在返 null（不抛）。 */
  findOrNull(sessionId: string): Promise<Session | null> {
    return this.sessionRepo.findOneBy({ id: sessionId });
  }
```

- [ ] **Step 5：跑测试看通过**

```bash
pnpm jest apps/server-agent/src/services/schedule-executor.service.spec.ts 2>&1 | tail -10
```

Expected：5 passed。

- [ ] **Step 6：Commit**

```bash
git add apps/server-agent/src/services/schedule-executor.service.ts \
        apps/server-agent/src/services/schedule-executor.service.spec.ts \
        apps/server-agent/src/services/session.service.ts
git commit -m "$(cat <<'EOF'
feat(server-agent): ScheduleExecutor —— bootstrap reload + fire 投递

cron 用 cron lib + tz 注册；once 用 setTimeout；过期 once 自动 disable。
fire 投递走 SessionService.appendMessage + RunnerService.kick 标准消息流。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5：ScheduleService 与 Executor 的 registry sync 接线

**Files:**
- Modify: `apps/server-agent/src/services/schedule.service.ts`

> ScheduleService 的 create / setEnabled / delete 需要在落库前后通知 Executor 同步 registry。注入 Executor 形成循环依赖 — 用 forwardRef + setter 模式：Executor 通过 setter 注入回 ScheduleService。

- [ ] **Step 1：扩 ScheduleService：可挂载 sink + 写时回调**

修改 `apps/server-agent/src/services/schedule.service.ts`：

顶部加：

```ts
/** 写入路径上通知 SchedulerRegistry 同步的钩子。由 ScheduleExecutor 在 bootstrap 阶段挂载。 */
export interface ScheduleRegistrySink {
  register(job: {
    id: string;
    kind: "cron" | "once";
    cronExpr: string | null;
    timezone: string | null;
    runAt: Date | null;
  }): void;
  deregister(jobId: string): void;
}
```

类内加 sink 字段 + 公开 setter：

```ts
  private sink: ScheduleRegistrySink | null = null;

  /** 由 ScheduleExecutor 启动时挂载。 */
  setRegistrySink(sink: ScheduleRegistrySink): void {
    this.sink = sink;
  }
```

改 `create / setEnabled / delete / deleteBySession`：

`create` 末尾：

```ts
    await this.repo.save(entity);
    if (entity.enabled) this.sink?.register(entity);
    return entity;
```

`setEnabled` 在 save 后根据值：

```ts
    const row = await this.findById(id);
    row.enabled = enabled;
    await this.repo.save(row);
    if (enabled) this.sink?.register(row);
    else this.sink?.deregister(row.id);
    return row;
```

`delete`：

```ts
  async delete(id: string): Promise<void> {
    this.sink?.deregister(id);
    await this.repo.delete({ id });
  }
```

`deleteBySession`：

```ts
  async deleteBySession(sessionId: string): Promise<void> {
    const rows = await this.repo.find({ where: { sessionId } });
    for (const r of rows) this.sink?.deregister(r.id);
    await this.repo.delete({ sessionId });
  }
```

- [ ] **Step 2：Executor 启动时挂载 sink**

修改 `apps/server-agent/src/services/schedule-executor.service.ts` 的 `onApplicationBootstrap` 开头：

```ts
  async onApplicationBootstrap(): Promise<void> {
    this.schedule.setRegistrySink({
      register: (job) => this.register(job),
      deregister: (id) => this.deregister(id),
    });
    const all = await this.schedule.list();
    for (const job of all) {
      if (!job.enabled) continue;
      this.register(job);
    }
  }
```

- [ ] **Step 3：补一个 sync 测试**

在 `apps/server-agent/src/services/schedule.service.spec.ts` 末尾追加：

```ts
describe("ScheduleService registry sink", () => {
  let ds: DataSource;
  let svc: ScheduleService;
  const calls: Array<["reg" | "dereg", string]> = [];

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [CronJob],
      synchronize: true,
    });
    await ds.initialize();
    svc = new ScheduleService(ds.getRepository(CronJob));
    calls.length = 0;
    svc.setRegistrySink({
      register: (j) => calls.push(["reg", j.id]),
      deregister: (id) => calls.push(["dereg", id]),
    });
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("create → sink.register；delete → sink.deregister", async () => {
    const job = await svc.create({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    expect(calls).toContainEqual(["reg", job.id]);
    await svc.delete(job.id);
    expect(calls).toContainEqual(["dereg", job.id]);
  });

  it("setEnabled(true→false) → deregister；(false→true) → register", async () => {
    const job = await svc.create({
      sessionId: "s1",
      title: "t",
      prompt: "p",
      kind: "cron",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
    });
    calls.length = 0;
    await svc.setEnabled(job.id, false);
    expect(calls).toEqual([["dereg", job.id]]);
    calls.length = 0;
    await svc.setEnabled(job.id, true);
    expect(calls).toEqual([["reg", job.id]]);
  });
});
```

- [ ] **Step 4：跑测试**

```bash
pnpm jest apps/server-agent/src/services/schedule.service.spec.ts apps/server-agent/src/services/schedule-executor.service.spec.ts 2>&1 | tail -10
```

Expected：全 PASS。

- [ ] **Step 5：Commit**

```bash
git add apps/server-agent/src/services/schedule.service.ts \
        apps/server-agent/src/services/schedule-executor.service.ts \
        apps/server-agent/src/services/schedule.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(server-agent): ScheduleService 写路径回调同步 SchedulerRegistry

通过 ScheduleRegistrySink 接口避免 Service / Executor 互相注入的循环依赖；
Executor.onApplicationBootstrap 挂载 sink；create / setEnabled / delete
路径上自动 register/deregister。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6：CronJobController + DTO + 模块接线

**Files:**
- Create: `apps/server-agent/src/dto/cron-job.dto.ts`
- Create: `apps/server-agent/src/controllers/cron-job.controller.ts`
- Modify: `apps/server-agent/src/session.module.ts`

- [ ] **Step 1：DTO**

新建 `apps/server-agent/src/dto/cron-job.dto.ts`：

```ts
import { createZodDto } from "@meshbot/common";
import {
  CreateCronJobSchema,
  PatchCronJobSchema,
} from "@meshbot/types-agent";

export class CreateCronJobDto extends createZodDto(CreateCronJobSchema) {}
export class PatchCronJobDto extends createZodDto(PatchCronJobSchema) {}
```

- [ ] **Step 2：Controller**

新建 `apps/server-agent/src/controllers/cron-job.controller.ts`：

```ts
import {
  type CronJobDto,
  type CronJobListResponse,
  CreateCronJobSchema,
  PatchCronJobSchema,
} from "@meshbot/types-agent";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { CreateCronJobDto, PatchCronJobDto } from "../dto/cron-job.dto";
import type { CronJob } from "../entities/cron-job.entity";
import { ScheduleService } from "../services/schedule.service";

function toDto(job: CronJob): CronJobDto {
  return {
    id: job.id,
    sessionId: job.sessionId,
    title: job.title,
    prompt: job.prompt,
    kind: job.kind,
    cronExpr: job.cronExpr,
    timezone: job.timezone,
    runAt: job.runAt ? job.runAt.toISOString() : null,
    enabled: job.enabled,
    lastFiredAt: job.lastFiredAt ? job.lastFiredAt.toISOString() : null,
    nextFireAt: job.nextFireAt ? job.nextFireAt.toISOString() : null,
    createdAt: job.createdAt.toISOString(),
  };
}

/** 计划任务 REST 端点。瘦 Controller —— 业务在 ScheduleService。 */
@Controller("api/cron-jobs")
export class CronJobController {
  constructor(private readonly schedule: ScheduleService) {}

  /** 列表：无参 = 全部；?sessionId=xxx 过滤。 */
  @Get()
  async list(
    @Query("sessionId") sessionId?: string,
  ): Promise<CronJobListResponse> {
    const jobs = await this.schedule.list(
      sessionId ? { sessionId } : undefined,
    );
    return { jobs: jobs.map(toDto) };
  }

  @Post()
  async create(@Body() body: CreateCronJobDto): Promise<CronJobDto> {
    const input = CreateCronJobSchema.parse(body);
    const job = await this.schedule.create(input);
    return toDto(job);
  }

  @Patch(":id")
  async patch(
    @Param("id") id: string,
    @Body() body: PatchCronJobDto,
  ): Promise<CronJobDto> {
    const input = PatchCronJobSchema.parse(body);
    if (input.enabled !== undefined) {
      await this.schedule.setEnabled(id, input.enabled);
    }
    if (input.title !== undefined) {
      await this.schedule.setTitle(id, input.title);
    }
    const job = await this.schedule.findById(id);
    return toDto(job);
  }

  @Delete(":id")
  async remove(@Param("id") id: string): Promise<{ deleted: true }> {
    await this.schedule.delete(id);
    return { deleted: true };
  }
}
```

- [ ] **Step 3：在 session.module 注册**

修改 `apps/server-agent/src/session.module.ts`：

- 顶部 import 加：

```ts
import { CronJob } from "./entities/cron-job.entity";
import { CronJobController } from "./controllers/cron-job.controller";
import { ScheduleService } from "./services/schedule.service";
import { ScheduleExecutor } from "./services/schedule-executor.service";
```

- `TxTypeOrmModule.forFeature([...])` 数组追加 `CronJob`
- `controllers:` 追加 `CronJobController`
- `providers:` 追加 `ScheduleService, ScheduleExecutor`
- `exports:` 追加 `ScheduleService`

- [ ] **Step 4：typecheck**

```bash
pnpm --filter @meshbot/server-agent typecheck 2>&1 | tail -5
```

Expected：exit 0。

- [ ] **Step 5：跑全 server-agent 单测确认无回归**

```bash
pnpm jest apps/server-agent 2>&1 | tail -5
```

Expected：全 PASS（含新加的 schedule 单测）。

- [ ] **Step 6：Commit**

```bash
git add apps/server-agent/src/dto/cron-job.dto.ts \
        apps/server-agent/src/controllers/cron-job.controller.ts \
        apps/server-agent/src/session.module.ts
git commit -m "$(cat <<'EOF'
feat(server-agent): /api/cron-jobs REST 端点 + 模块接线

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7：SessionService.deleteSession 级联删 cron_jobs

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`

- [ ] **Step 1：注入 ScheduleService + 级联**

定位 `deleteSession` / `deleteSessionInTx`（约 line 299-311）。

constructor 加注入 `private readonly schedules: ScheduleService`。

`deleteSession` 末尾、`checkpointer.deleteThread` 之前加：

```ts
    await this.schedules.deleteBySession(sessionId);
```

> 不放进 `@Transactional` 的 `deleteSessionInTx`：sink 同步是内存操作 + sqlite delete，不必跨域 join 事务；与 checkpointer.deleteThread 同款外层调用。

- [ ] **Step 2：typecheck + 跑 session 单测**

```bash
pnpm --filter @meshbot/server-agent typecheck 2>&1 | tail -5
pnpm jest apps/server-agent/src/services/session.service.spec.ts 2>&1 | tail -5
```

Expected：typecheck exit 0；session 既有单测全 PASS（若 mock 不足 fail，加 `schedules: { deleteBySession: jest.fn() }` 这种 fake 注入）。

- [ ] **Step 3：Commit**

```bash
git add apps/server-agent/src/services/session.service.ts apps/server-agent/src/services/session.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(server-agent): deleteSession 级联删该会话的所有 cron_jobs

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8：libs/agent ScheduleToolsPort + 3 个 tool

**Files:**
- Create: `libs/agent/src/tools/schedule-tools.port.ts`
- Create: `libs/agent/src/tools/builtins/schedule-create.tool.ts`
- Create: `libs/agent/src/tools/builtins/schedule-list.tool.ts`
- Create: `libs/agent/src/tools/builtins/schedule-delete.tool.ts`
- Create: 同名 `.spec.ts` 测试文件

- [ ] **Step 1：Port + 接口**

新建 `libs/agent/src/tools/schedule-tools.port.ts`：

```ts
import type { CronJobDto, CreateCronJobInput } from "@meshbot/types-agent";

/** libs/agent → apps/server-agent 解耦的注入边界。
 *
 * apps/server-agent 在模块中提供 `{ provide: SCHEDULE_TOOLS_PORT, useExisting: ScheduleService }`。
 */
export const SCHEDULE_TOOLS_PORT = Symbol("SCHEDULE_TOOLS_PORT");

export interface ScheduleToolsPort {
  create(input: CreateCronJobInput): Promise<{ id: string; nextFireAt: Date | null }>;
  listBySession(sessionId: string): Promise<CronJobDto[]>;
  findOwnedBy(
    id: string,
    sessionId: string,
  ): Promise<CronJobDto | null>;
  delete(id: string): Promise<void>;
}
```

- [ ] **Step 2：schedule_create tool**

新建 `libs/agent/src/tools/builtins/schedule-create.tool.ts`：

```ts
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  SCHEDULE_TOOLS_PORT,
  type ScheduleToolsPort,
} from "../schedule-tools.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(["cron", "once"]),
  cronExpr: z
    .string()
    .optional()
    .describe(
      "5-field cron expression (m h dom mon dow). REQUIRED when kind='cron'.",
    ),
  runAt: z
    .string()
    .datetime()
    .optional()
    .describe("ISO 8601 datetime. REQUIRED when kind='once'."),
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA timezone for cron schedule. Defaults to server OS timezone.",
    ),
  prompt: z
    .string()
    .min(1)
    .describe(
      "The user message that will be delivered to this session when the job fires.",
    ),
});
type Args = z.input<typeof ArgsSchema>;

@Injectable()
@Tool()
export class ScheduleCreateTool
  implements MeshbotTool<Args, string>
{
  readonly name = "schedule_create";
  readonly description =
    "Create a scheduled task (cron repeat or one-shot) bound to the CURRENT session. " +
    "When kind='cron', cronExpr is REQUIRED. When kind='once', runAt is REQUIRED. " +
    "Returns job id + next fire time.";
  readonly schema = ArgsSchema;

  constructor(
    @Inject(SCHEDULE_TOOLS_PORT)
    private readonly port: ScheduleToolsPort,
  ) {}

  async execute(args: Args, ctx: ToolContext): Promise<string> {
    const tz =
      args.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { id, nextFireAt } = await this.port.create({
      sessionId: ctx.sessionId,
      title: args.title,
      prompt: args.prompt,
      kind: args.kind,
      cronExpr: args.cronExpr,
      timezone: args.kind === "cron" ? tz : undefined,
      runAt: args.runAt,
    });
    return `Created scheduled job ${id}. Next fire: ${nextFireAt?.toISOString() ?? "n/a"}.`;
  }
}
```

- [ ] **Step 3：schedule_list tool**

新建 `libs/agent/src/tools/builtins/schedule-list.tool.ts`：

```ts
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  SCHEDULE_TOOLS_PORT,
  type ScheduleToolsPort,
} from "../schedule-tools.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({});
type Args = z.input<typeof ArgsSchema>;

@Injectable()
@Tool()
export class ScheduleListTool implements MeshbotTool<Args, string> {
  readonly name = "schedule_list";
  readonly description =
    "List scheduled tasks owned by the CURRENT session. " +
    "Cannot see tasks from other sessions.";
  readonly schema = ArgsSchema;

  constructor(
    @Inject(SCHEDULE_TOOLS_PORT)
    private readonly port: ScheduleToolsPort,
  ) {}

  async execute(_args: Args, ctx: ToolContext): Promise<string> {
    const jobs = await this.port.listBySession(ctx.sessionId);
    if (jobs.length === 0) return "No scheduled tasks in this session.";
    return JSON.stringify(
      jobs.map((j) => ({
        id: j.id,
        title: j.title,
        kind: j.kind,
        cronExpr: j.cronExpr,
        runAt: j.runAt,
        enabled: j.enabled,
        nextFireAt: j.nextFireAt,
        lastFiredAt: j.lastFiredAt,
      })),
      null,
      2,
    );
  }
}
```

- [ ] **Step 4：schedule_delete tool**

新建 `libs/agent/src/tools/builtins/schedule-delete.tool.ts`：

```ts
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  SCHEDULE_TOOLS_PORT,
  type ScheduleToolsPort,
} from "../schedule-tools.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  id: z.string().min(1).describe("Job id to delete."),
});
type Args = z.input<typeof ArgsSchema>;

@Injectable()
@Tool()
export class ScheduleDeleteTool implements MeshbotTool<Args, string> {
  readonly name = "schedule_delete";
  readonly description =
    "Delete a scheduled task owned by the CURRENT session. " +
    "Returns error if id does not belong to current session.";
  readonly schema = ArgsSchema;

  constructor(
    @Inject(SCHEDULE_TOOLS_PORT)
    private readonly port: ScheduleToolsPort,
  ) {}

  async execute(args: Args, ctx: ToolContext): Promise<string> {
    const job = await this.port.findOwnedBy(args.id, ctx.sessionId);
    if (!job) {
      return `Error: job ${args.id} not found or not owned by this session.`;
    }
    await this.port.delete(args.id);
    return `Deleted ${args.id}.`;
  }
}
```

- [ ] **Step 5：3 个 tool 单测**

新建 `libs/agent/src/tools/builtins/schedule-tools.spec.ts`：

```ts
import type { ToolContext } from "../tool.types";
import { ScheduleCreateTool } from "./schedule-create.tool";
import { ScheduleDeleteTool } from "./schedule-delete.tool";
import { ScheduleListTool } from "./schedule-list.tool";

function fakeCtx(sessionId: string): ToolContext {
  return {
    sessionId,
    messageId: "m1",
    toolCallId: "tc1",
    emitter: {} as never,
    signal: new AbortController().signal,
  };
}

describe("schedule tools", () => {
  it("schedule_create 用 ctx.sessionId 绑定；缺省 timezone = OS", async () => {
    const port = {
      create: jest.fn().mockResolvedValue({ id: "j1", nextFireAt: new Date() }),
      listBySession: jest.fn(),
      findOwnedBy: jest.fn(),
      delete: jest.fn(),
    };
    const tool = new ScheduleCreateTool(port);
    const out = await tool.execute(
      {
        title: "morning",
        kind: "cron",
        cronExpr: "0 7 * * *",
        prompt: "good morning",
      },
      fakeCtx("session-A"),
    );
    expect(port.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-A",
        timezone: expect.any(String),
      }),
    );
    expect(out).toMatch(/Created scheduled job j1/);
  });

  it("schedule_list 只列当前 session", async () => {
    const port = {
      create: jest.fn(),
      listBySession: jest.fn().mockResolvedValue([
        {
          id: "j1",
          sessionId: "session-A",
          title: "t",
          prompt: "p",
          kind: "cron",
          cronExpr: "0 7 * * *",
          timezone: "UTC",
          runAt: null,
          enabled: true,
          lastFiredAt: null,
          nextFireAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]),
      findOwnedBy: jest.fn(),
      delete: jest.fn(),
    };
    const tool = new ScheduleListTool(port);
    const out = await tool.execute({}, fakeCtx("session-A"));
    expect(port.listBySession).toHaveBeenCalledWith("session-A");
    expect(out).toMatch(/j1/);
  });

  it("schedule_delete 越权 → 返回 Error 字串", async () => {
    const port = {
      create: jest.fn(),
      listBySession: jest.fn(),
      findOwnedBy: jest.fn().mockResolvedValue(null),
      delete: jest.fn(),
    };
    const tool = new ScheduleDeleteTool(port);
    const out = await tool.execute(
      { id: "j-other" },
      fakeCtx("session-A"),
    );
    expect(out).toMatch(/Error: job j-other not found/);
    expect(port.delete).not.toHaveBeenCalled();
  });

  it("schedule_delete 合法删除", async () => {
    const port = {
      create: jest.fn(),
      listBySession: jest.fn(),
      findOwnedBy: jest.fn().mockResolvedValue({ id: "j1" }),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const tool = new ScheduleDeleteTool(port);
    const out = await tool.execute({ id: "j1" }, fakeCtx("session-A"));
    expect(port.delete).toHaveBeenCalledWith("j1");
    expect(out).toMatch(/Deleted j1/);
  });
});
```

- [ ] **Step 6：跑测试**

```bash
pnpm jest libs/agent/src/tools/builtins/schedule-tools.spec.ts 2>&1 | tail -8
```

Expected：4 passed。

- [ ] **Step 7：Commit**

```bash
git add libs/agent/src/tools/schedule-tools.port.ts \
        libs/agent/src/tools/builtins/schedule-create.tool.ts \
        libs/agent/src/tools/builtins/schedule-list.tool.ts \
        libs/agent/src/tools/builtins/schedule-delete.tool.ts \
        libs/agent/src/tools/builtins/schedule-tools.spec.ts
git commit -m "$(cat <<'EOF'
feat(agent): schedule_create / list / delete 3 个 builtin tool

通过 SCHEDULE_TOOLS_PORT token 注入边界解耦 apps/server-agent；
sessionId 一律从 ToolContext 取，schema 不暴露 sessionId 防越权。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9：注册 port 实现 + 把 3 tool 装入 AgentModule

**Files:**
- Modify: `libs/agent/src/agent.module.ts`
- Modify: `apps/server-agent/src/session.module.ts`
- Modify: `apps/server-agent/src/services/schedule.service.ts`（实现 `findOwnedBy` 接口方法）

> ScheduleToolsPort 的 4 个方法在 ScheduleService 已有 3 个（create / listBySession 等价 list({sessionId}) / delete）；要补 `findOwnedBy(id, sessionId)`。

- [ ] **Step 1：ScheduleService 实现 ScheduleToolsPort 接口**

修改 `apps/server-agent/src/services/schedule.service.ts`：

类签名加 `implements ScheduleToolsPort`（顶部 import：`import type { ScheduleToolsPort } from "@meshbot/agent"`）。

加方法：

```ts
  /** 按 (id, sessionId) 查；仅返回属于该 session 的行（防越权工具用）。 */
  async findOwnedBy(
    id: string,
    sessionId: string,
  ): Promise<CronJob | null> {
    const row = await this.repo.findOneBy({ id });
    if (!row || row.sessionId !== sessionId) return null;
    return row;
  }

  /** ScheduleToolsPort 别名：列当前 session 任务。 */
  listBySession(sessionId: string): Promise<CronJob[]> {
    return this.list({ sessionId });
  }
```

`create` 已存在但要让返回符合 port 接口的 `{ id, nextFireAt }` —— 不必改 create 本身签名，端口在 Module 提供时用 `useValue` adapter 适配即可（见 Step 3）。

- [ ] **Step 2：libs/agent barrel 导出 port**

修改 `libs/agent/src/index.ts`（若已有 barrel；否则在 agent.module.ts 同级）：

```ts
export * from "./tools/schedule-tools.port";
```

- [ ] **Step 3：AgentModule 注册 3 个 tool**

修改 `libs/agent/src/agent.module.ts`：

import + providers 数组追加：

```ts
import { ScheduleCreateTool } from "./tools/builtins/schedule-create.tool";
import { ScheduleListTool } from "./tools/builtins/schedule-list.tool";
import { ScheduleDeleteTool } from "./tools/builtins/schedule-delete.tool";
```

`providers:` 中追加 `ScheduleCreateTool, ScheduleListTool, ScheduleDeleteTool`。

不在 AgentModule 里提供 `SCHEDULE_TOOLS_PORT` —— 由依赖方 apps/server-agent 注入实现（避免 lib 内出现循环依赖）。

- [ ] **Step 4：session.module 注册 port = ScheduleService**

修改 `apps/server-agent/src/session.module.ts`：

`providers:` 追加：

```ts
import { SCHEDULE_TOOLS_PORT } from "@meshbot/agent";

// ...
providers: [
  // ... 其他
  ScheduleService,
  ScheduleExecutor,
  { provide: SCHEDULE_TOOLS_PORT, useExisting: ScheduleService },
],
```

- [ ] **Step 5：typecheck**

```bash
pnpm --filter @meshbot/agent typecheck && pnpm --filter @meshbot/server-agent typecheck
```

Expected：exit 0。

- [ ] **Step 6：Commit**

```bash
git add libs/agent/src/agent.module.ts libs/agent/src/index.ts \
        apps/server-agent/src/session.module.ts \
        apps/server-agent/src/services/schedule.service.ts
git commit -m "$(cat <<'EOF'
feat: 装 schedule tools 进 AgentModule + 注册 SCHEDULE_TOOLS_PORT

ScheduleService 实现 ScheduleToolsPort 接口；session.module 提供
{ provide: SCHEDULE_TOOLS_PORT, useExisting: ScheduleService } 完成解耦。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10：date.tool timezone 默认 OS

**Files:**
- Modify: `libs/agent/src/tools/builtins/date.tool.ts`
- Modify: `libs/agent/src/tools/builtins/date.tool.spec.ts`（若有）

- [ ] **Step 1：改 schema**

修改 `libs/agent/src/tools/builtins/date.tool.ts`：

`DateArgsSchema` 的 `timezone` 字段：

```ts
  timezone: z
    .string()
    .min(1)
    .optional()
    .describe(
      "IANA timezone, e.g. 'Asia/Shanghai'. Defaults to server OS timezone. " +
        "Pass explicitly to override.",
    ),
```

`execute` 起始：

```ts
  async execute(args: DateArgs, _ctx: ToolContext): Promise<string> {
    const tz =
      args.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      return (
        `Error: invalid IANA timezone "${tz}". ` +
        `Try Asia/Shanghai, America/New_York, UTC.`
      );
    }
    const now = new Date();
    switch (args.format) {
      case "iso":
        return formatIso(now, tz);
      case "rfc":
        return formatRfc(now, tz);
      default:
        return formatHuman(now, tz);
    }
  }
```

`description` 顶部「If user's timezone is unknown, ASK the user first — do NOT guess.」改：

```ts
  readonly description =
    "Return the current date/time. Defaults to the server's OS timezone; " +
    "pass `timezone` (IANA) to override.";
```

- [ ] **Step 2：补 / 改单测**

定位 `apps/server-agent/src/services` 或 `libs/agent` 是否已有 date.tool 单测：

```bash
find . -name "date.tool.spec.ts" 2>&1 | grep -v node_modules
```

若有，确认现有 case 仍通过；追加：

```ts
it("不传 timezone → 走 OS 默认，不抛", async () => {
  const tool = new DateTool();
  const out = await tool.execute({} as never, {} as never);
  expect(out).not.toMatch(/^Error/);
});
```

若无单测文件则新建（路径与 tool 同目录）。

- [ ] **Step 3：跑测试 + typecheck**

```bash
pnpm jest libs/agent/src/tools/builtins/date.tool 2>&1 | tail -5
pnpm --filter @meshbot/agent typecheck
```

Expected：全 PASS；typecheck exit 0。

- [ ] **Step 4：Commit**

```bash
git add libs/agent/src/tools/builtins/date.tool.ts libs/agent/src/tools/builtins/date.tool.spec.ts
git commit -m "$(cat <<'EOF'
feat(agent): date tool timezone 改 optional + 默认 OS

不再强制要求用户传 timezone；Intl.DateTimeFormat().resolvedOptions().timeZone
作为缺省。与新的 schedule 工具 timezone 处理一致。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11：web-agent rest helpers cron-jobs

**Files:**
- Create: `apps/web-agent/src/rest/cron-jobs.ts`
- Modify: `apps/web-agent/src/rest/index.ts`

- [ ] **Step 1：写 helpers**

新建 `apps/web-agent/src/rest/cron-jobs.ts`：

```ts
"use client";

import type {
  CreateCronJobInput,
  CronJobDto,
  CronJobListResponse,
  PatchCronJobInput,
} from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/** 列出所有计划任务（可按 sessionId 过滤）。 */
export async function listCronJobs(
  opts?: { sessionId?: string },
): Promise<CronJobListResponse> {
  const { data } = await apiClient.get<CronJobListResponse>("/api/cron-jobs", {
    params: opts?.sessionId ? { sessionId: opts.sessionId } : undefined,
  });
  return data;
}

/** 创建计划任务。 */
export async function createCronJob(
  input: CreateCronJobInput,
): Promise<CronJobDto> {
  const { data } = await apiClient.post<CronJobDto>("/api/cron-jobs", input);
  return data;
}

/** 修改 enabled / title。 */
export async function patchCronJob(
  id: string,
  input: PatchCronJobInput,
): Promise<CronJobDto> {
  const { data } = await apiClient.patch<CronJobDto>(
    `/api/cron-jobs/${id}`,
    input,
  );
  return data;
}

/** 删除一条。 */
export async function deleteCronJob(
  id: string,
): Promise<{ deleted: true }> {
  const { data } = await apiClient.delete<{ deleted: true }>(
    `/api/cron-jobs/${id}`,
  );
  return data;
}
```

- [ ] **Step 2：barrel re-export**

`apps/web-agent/src/rest/index.ts` 顶部 import 块追加：

```ts
export {
  listCronJobs,
  createCronJob,
  patchCronJob,
  deleteCronJob,
} from "./cron-jobs";
```

- [ ] **Step 3：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck 2>&1 | tail -5
```

Expected：exit 0。

- [ ] **Step 4：Commit**

```bash
git add apps/web-agent/src/rest/cron-jobs.ts apps/web-agent/src/rest/index.ts
git commit -m "$(cat <<'EOF'
feat(web-agent): cron-jobs REST helpers（list / create / patch / delete）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12：i18n keys（schedule.*）

**Files:**
- Modify: `apps/web-agent/messages/zh.json`
- Modify: `apps/web-agent/messages/en.json`

- [ ] **Step 1：定位 `"schedule"` 块**

```bash
grep -n '"schedule"' apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
```

若已有占位 `schedule.title`，扩为完整对象。

- [ ] **Step 2：zh.json 写入**

把 `"schedule"` 整段替换为：

```json
    "schedule": {
      "title": "计划任务",
      "empty": "暂无计划任务，让 agent 帮你创建或点右上角「新建」",
      "newJob": "新建",
      "kindCron": "重复（cron）",
      "kindOnce": "一次性",
      "cronExpr": "cron 表达式",
      "cronPlaceholder": "0 7 * * *",
      "cronPreview": "下次：{next}",
      "timezone": "时区",
      "runAt": "执行时间",
      "prompt": "投递内容",
      "promptPlaceholder": "到点后会作为 user 消息发到所选会话",
      "session": "目标会话",
      "jobTitle": "任务名",
      "jobTitlePlaceholder": "例：每日早报",
      "save": "创建",
      "cancel": "取消",
      "delete": "删除",
      "enable": "启用",
      "disable": "停用",
      "enabled": "启用中",
      "disabled": "已停用",
      "nextFire": "下次：{when}",
      "lastFire": "上次：{when}",
      "deleteConfirm": "确定删除「{title}」吗？",
      "validation": {
        "cronRequired": "请输入 cron 表达式",
        "cronInvalid": "cron 表达式无效",
        "runAtRequired": "请选择执行时间",
        "runAtPast": "执行时间必须在未来"
      }
    }
```

- [ ] **Step 3：en.json 写入**

```json
    "schedule": {
      "title": "Scheduled tasks",
      "empty": "No scheduled tasks yet. Ask the agent to create one or click \"New\"",
      "newJob": "New",
      "kindCron": "Recurring (cron)",
      "kindOnce": "One-shot",
      "cronExpr": "Cron expression",
      "cronPlaceholder": "0 7 * * *",
      "cronPreview": "Next: {next}",
      "timezone": "Timezone",
      "runAt": "Run at",
      "prompt": "Prompt",
      "promptPlaceholder": "Sent as a user message to the target session when fired",
      "session": "Target session",
      "jobTitle": "Title",
      "jobTitlePlaceholder": "e.g. Morning briefing",
      "save": "Create",
      "cancel": "Cancel",
      "delete": "Delete",
      "enable": "Enable",
      "disable": "Disable",
      "enabled": "Enabled",
      "disabled": "Disabled",
      "nextFire": "Next: {when}",
      "lastFire": "Last: {when}",
      "deleteConfirm": "Delete \"{title}\"?",
      "validation": {
        "cronRequired": "Cron expression required",
        "cronInvalid": "Invalid cron expression",
        "runAtRequired": "Run-at time required",
        "runAtPast": "Run-at must be in the future"
      }
    }
```

- [ ] **Step 4：JSON 合法 + locales 对齐**

```bash
node -e "JSON.parse(require('fs').readFileSync('apps/web-agent/messages/zh.json','utf8'));JSON.parse(require('fs').readFileSync('apps/web-agent/messages/en.json','utf8'));console.log('valid')"
pnpm sync:locales -- --check 2>&1 | tail -5
```

Expected：`valid`；sync:locales `missing=0, asymmetric=0`（如有 missing，按已有惯例 `pnpm sync:locales -- --write` 顶层补占位再 check）。

- [ ] **Step 5：Commit**

```bash
git add apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "$(cat <<'EOF'
feat(web-agent): schedule.* i18n 文案（zh / en 对称）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13：CronJobCard 组件 + 列表 page 骨架

**Files:**
- Create: `apps/web-agent/src/components/schedule/cron-job-card.tsx`
- Modify: `apps/web-agent/src/app/schedule/page.tsx`

- [ ] **Step 1：CronJobCard**

新建 `apps/web-agent/src/components/schedule/cron-job-card.tsx`：

```tsx
"use client";

import { cn } from "@meshbot/design";
import type { CronJobDto } from "@meshbot/types-agent";
import { Trash2 } from "lucide-react";
import cronstrue from "cronstrue/i18n";
import Link from "next/link";
import { useTranslations } from "next-intl";

interface Props {
  job: CronJobDto;
  onToggle: (next: boolean) => void;
  onDelete: () => void;
  busy?: boolean;
}

export function CronJobCard({ job, onToggle, onDelete, busy }: Props) {
  const t = useTranslations("schedule");
  const scheduleLine =
    job.kind === "cron"
      ? `${job.cronExpr} · ${cronstrue.toString(job.cronExpr as string, { locale: "zh_CN", throwExceptionOnParseError: false })}${job.timezone ? ` (${job.timezone})` : ""}`
      : new Date(job.runAt as string).toLocaleString();
  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-card p-3">
      <div className="min-w-0 flex-1">
        <Link
          href={`/session?id=${job.sessionId}`}
          className="block truncate text-sm font-medium hover:underline"
        >
          {job.title}
        </Link>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {job.prompt}
        </p>
        <p className="mt-1 text-[11px] text-foreground/60">{scheduleLine}</p>
        {job.nextFireAt && (
          <p className="mt-0.5 text-[11px] text-foreground/50">
            {t("nextFire", { when: new Date(job.nextFireAt).toLocaleString() })}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => onToggle(!job.enabled)}
          disabled={busy}
          className={cn(
            "rounded px-2 py-1 text-[11px]",
            job.enabled
              ? "bg-foreground/8 text-foreground"
              : "bg-muted text-muted-foreground",
          )}
        >
          {job.enabled ? t("enabled") : t("disabled")}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          title={t("delete")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2：列表 page 骨架**

修改 `apps/web-agent/src/app/schedule/page.tsx`：

```tsx
"use client";

import type { CronJobDto } from "@meshbot/types-agent";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { CronJobCard } from "@/components/schedule/cron-job-card";
import {
  deleteCronJob,
  listCronJobs,
  patchCronJob,
} from "@/rest/cron-jobs";

export default function SchedulePage() {
  const t = useTranslations("schedule");
  const [jobs, setJobs] = useState<CronJobDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { jobs } = await listCronJobs();
      setJobs(jobs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleToggle = useCallback(
    async (id: string, next: boolean) => {
      setBusyId(id);
      try {
        await patchCronJob(id, { enabled: next });
        await reload();
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const handleDelete = useCallback(
    async (id: string, title: string) => {
      if (!confirm(t("deleteConfirm", { title }))) return;
      setBusyId(id);
      try {
        await deleteCronJob(id);
        await reload();
      } finally {
        setBusyId(null);
      }
    },
    [reload, t],
  );

  return (
    <AppShellLayout>
      <div className="mx-auto w-full max-w-2xl p-4">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-medium">{t("title")}</h1>
          <button
            type="button"
            onClick={() => setFormOpen((v) => !v)}
            className="rounded-md bg-foreground/8 px-3 py-1.5 text-sm font-medium hover:bg-foreground/12"
          >
            {formOpen ? t("cancel") : t("newJob")}
          </button>
        </div>

        {formOpen && (
          <div className="mb-4 rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
            {/* 表单在 Task 14 接入；本步骤先占位 */}
            (form placeholder)
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {jobs.map((j) => (
              <CronJobCard
                key={j.id}
                job={j}
                busy={busyId === j.id}
                onToggle={(next) => handleToggle(j.id, next)}
                onDelete={() => handleDelete(j.id, j.title)}
              />
            ))}
          </div>
        )}
      </div>
    </AppShellLayout>
  );
}
```

- [ ] **Step 3：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck 2>&1 | tail -5
```

Expected：exit 0。

- [ ] **Step 4：Commit**

```bash
git add apps/web-agent/src/components/schedule/cron-job-card.tsx apps/web-agent/src/app/schedule/page.tsx
git commit -m "$(cat <<'EOF'
feat(web-agent): /schedule 列表骨架 + CronJobCard

cron 表达式用 cronstrue 翻人话；点 title 跳到关联会话；启停 + 删除按钮。
form placeholder 占位，Task 14 接入。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14：CronJobForm + 接入 page

**Files:**
- Create: `apps/web-agent/src/components/schedule/cron-job-form.tsx`
- Modify: `apps/web-agent/src/app/schedule/page.tsx`

- [ ] **Step 1：CronJobForm**

新建 `apps/web-agent/src/components/schedule/cron-job-form.tsx`：

```tsx
"use client";

import type {
  CreateCronJobInput,
  SessionSummary,
} from "@meshbot/types-agent";
import cronstrue from "cronstrue/i18n";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

interface Props {
  sessions: SessionSummary[];
  defaultSessionId?: string;
  onSubmit: (input: CreateCronJobInput) => Promise<void>;
  onCancel: () => void;
}

const browserTz =
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC";

export function CronJobForm({
  sessions,
  defaultSessionId,
  onSubmit,
  onCancel,
}: Props) {
  const t = useTranslations("schedule");
  const [sessionId, setSessionId] = useState(
    defaultSessionId ?? sessions[0]?.id ?? "",
  );
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"cron" | "once">("cron");
  const [cronExpr, setCronExpr] = useState("0 7 * * *");
  const [timezone, setTimezone] = useState(browserTz);
  const [runAt, setRunAt] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cronPreview = useMemo(() => {
    if (kind !== "cron" || !cronExpr) return null;
    try {
      return cronstrue.toString(cronExpr, {
        locale: "zh_CN",
        throwExceptionOnParseError: true,
      });
    } catch {
      return null;
    }
  }, [kind, cronExpr]);

  useEffect(() => {
    setError(null);
  }, [kind, cronExpr, runAt]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (kind === "cron" && !cronPreview) {
      setError(t("validation.cronInvalid"));
      return;
    }
    if (kind === "once" && !runAt) {
      setError(t("validation.runAtRequired"));
      return;
    }
    if (kind === "once" && new Date(runAt).getTime() <= Date.now()) {
      setError(t("validation.runAtPast"));
      return;
    }
    setBusy(true);
    try {
      const input: CreateCronJobInput = {
        sessionId,
        title,
        prompt,
        kind,
        cronExpr: kind === "cron" ? cronExpr : undefined,
        timezone: kind === "cron" ? timezone : undefined,
        runAt:
          kind === "once" ? new Date(runAt).toISOString() : undefined,
      };
      await onSubmit(input);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-3 text-sm"
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t("jobTitle")}</span>
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("jobTitlePlaceholder")}
          className="rounded border border-border bg-background px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t("session")}</span>
        <select
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1"
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={kind === "cron"}
            onChange={() => setKind("cron")}
          />
          {t("kindCron")}
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={kind === "once"}
            onChange={() => setKind("once")}
          />
          {t("kindOnce")}
        </label>
      </div>

      {kind === "cron" ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t("cronExpr")}
            </span>
            <input
              required
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder={t("cronPlaceholder")}
              className="rounded border border-border bg-background px-2 py-1 font-mono"
            />
          </label>
          {cronPreview && (
            <p className="text-xs text-muted-foreground">{cronPreview}</p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t("timezone")}
            </span>
            <input
              required
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1"
            />
          </label>
        </div>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t("runAt")}</span>
          <input
            type="datetime-local"
            required
            value={runAt}
            onChange={(e) => setRunAt(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1"
          />
        </label>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t("prompt")}</span>
        <textarea
          required
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("promptPlaceholder")}
          rows={3}
          className="rounded border border-border bg-background px-2 py-1"
        />
      </label>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
        >
          {t("cancel")}
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-foreground px-3 py-1 text-sm text-background hover:opacity-90 disabled:opacity-50"
        >
          {t("save")}
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2：page 接入表单**

修改 `apps/web-agent/src/app/schedule/page.tsx`：

顶部 import 加：

```tsx
import { useAtomValue } from "jotai";
import { sessionsAtom } from "@/atoms/sessions";
import { CronJobForm } from "@/components/schedule/cron-job-form";
import { createCronJob } from "@/rest/cron-jobs";
```

> 如果 `sessionsAtom` 路径不同，先 grep `grep -rn "sessionsAtom" apps/web-agent/src/atoms/ | head -3` 用实际命名。

在 `SchedulePage` 函数体顶部加：

```tsx
  const sessions = useAtomValue(sessionsAtom);
```

把 `(form placeholder)` 占位块替换为：

```tsx
        {formOpen && (
          <div className="mb-4">
            <CronJobForm
              sessions={sessions}
              onCancel={() => setFormOpen(false)}
              onSubmit={async (input) => {
                await createCronJob(input);
                setFormOpen(false);
                await reload();
              }}
            />
          </div>
        )}
```

- [ ] **Step 3：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck 2>&1 | tail -5
```

Expected：exit 0。如果 `sessionsAtom` 类型不一致，按当前 atom 暴露的类型适配 form props。

- [ ] **Step 4：Commit**

```bash
git add apps/web-agent/src/components/schedule/cron-job-form.tsx apps/web-agent/src/app/schedule/page.tsx
git commit -m "$(cat <<'EOF'
feat(web-agent): CronJobForm + /schedule 新建表单接入

cron / once 切换；timezone 默认浏览器时区；cron 表达式 cronstrue 实时翻译；
提交后调 createCronJob 并刷列表。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15：整体验证

**Files:** 无（验证）

- [ ] **Step 1：typecheck + 全测试 + 围栏 + locales**

```bash
pnpm typecheck
pnpm test
pnpm check
pnpm sync:locales -- --check
```

Expected：
- typecheck exit 0
- 全测试 PASS（含 schedule 系列单测）
- 6 围栏 0 finding（重点 `check:repo` 验证 `CronJob` 唯一归属 `ScheduleService`，controller / tool 未注入 Repo）
- locales `missing=0, asymmetric=0`

- [ ] **Step 2：手动验证**

```bash
pnpm dev:server-agent
pnpm dev:web-agent
```

验证清单（spec § 10 验收）：
1. 浏览器开一个会话 → 让 agent「每分钟提醒我休息（用于演示）」→ assistant 调 `schedule_create` → `/schedule` 列表出现该 job → 1 分钟内目标会话出现一条 user 消息 + assistant 回复
2. UI 新建 cron `* * * * *` → 同上
3. 启停 toggle → 不再触发；再开启 → 下次到点照常
4. UI 删除 job → registry 反注册 + 行消失
5. 重启 server-agent → enabled 的 cron job reload，仍按期触发
6. 删除某会话 → 该会话的 job 级联消失（`/schedule` 列表 + DB 都空）
7. `date.tool` 不传 timezone → 走系统 OS（assistant 应能在不询问时区的情况下回答「现在几点」）

- [ ] **Step 3：收尾**

```bash
git log --oneline -16
```

确认 14 个功能 commit + 0 个 amend；plan 完成。

---

## Self-Review

**Spec coverage：**
- 投递目标 = 原会话 → Task 4 fire 调 `sessions.appendMessage(sessionId)` + `runner.kick` ✓
- 任务类型 cron + once → Task 2 schema + Task 3 entity + Task 4 fire 两分支 ✓
- 调度引擎 @nestjs/schedule + bootstrap reload → Task 1 全局 ScheduleModule + Task 4 onApplicationBootstrap ✓
- 错过的点丢弃 → Task 4 过期 once 直接 disable；cron 自然 skip（cron lib 不补跑） ✓
- agent 无需确认 → Task 8 tool 直接调 port 创建 ✓
- 时区默认 OS → Task 8 tool 内 `Intl.DateTimeFormat()` fallback；Task 10 date.tool；Task 14 form 浏览器时区 ✓
- 不在范围（编辑 / 历史详情 / 跨会话 / geolocation）→ 未涉及 ✓
- session 删除级联 → Task 7 ✓
- check:repo CronJob 唯一归属 → Task 3 只有 ScheduleService 注入 Repository；Task 6 Controller 注 ScheduleService；Task 8 tool 注 port，不碰 Repo ✓

**Placeholder scan：** 无 TBD / 「适当处理边缘场景」/ 「类似 Task N」 ✓

**Type consistency：**
- `CreateCronJobInput` 跨 Task 2 / 3 / 6 / 8 / 11 / 14 一致
- `CronJobDto` 跨 Task 2 / 6 / 11 / 13 一致
- `ScheduleToolsPort` 4 方法（create / listBySession / findOwnedBy / delete）跨 Task 8 / 9 一致
- `ScheduleRegistrySink` 跨 Task 4 / 5 一致

**已知整合点：** Task 14 引用 `sessionsAtom`，路径以实际 atom 文件命名为准（plan 含 grep 指引）；Task 7 注入 ScheduleService 到 SessionService 会让 spec 的 session.service mock 测试稍作扩展，plan 已说明。

---

## 执行选项

Plan complete and saved to `docs/superpowers/plans/2026-05-28-schedule-tasks.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 每 task 一个 fresh subagent + 双 review，串行执行
**2. Inline Execution** - 本会话内批处理 + 检查点

Which approach?
