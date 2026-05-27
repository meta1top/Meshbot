# 计划任务（Schedule Tasks）设计稿

> 日期：2026-05-28
> 范围：server-agent 新增 `cron_jobs` 表 + 调度执行 + REST 端点；libs/agent 新增 3 个 agent 工具 + 改 `date.tool`；web-agent `/schedule` 页面重写为列表 + 新建对话框。

## 1. 目标

让用户和 agent 都能创建可重复（cron）/ 一次性（once）的定时任务，到点自动以「user 消息」形式投递到指定会话，触发 LLM 正常 run。失败按标准 timeline 流走，不引入独立通道。

## 2. 关键决策（已与用户对齐）

| 决策 | 选项 | 说明 |
|---|---|---|
| 投递目标 | 回**创建任务时**所属的原会话 | 时间线连续可追溯；不污染会话面板 |
| 任务类型 | **cron + one-shot** | 5 字段标准 cron（最低 1 分钟粒度）+ ISO 时刻 |
| 调度引擎 | **@nestjs/schedule** 的 `SchedulerRegistry` 动态注册 | 与 SQLite 单进程 + 本地优先架构契合；不引入 Redis |
| 错过的点 | **丢弃** | 进程不在 / 关机错过的，开机后从下一次开始；不补跑 |
| Agent 自主创建 | **无需用户确认** | 类 bash 工具的信任模型；UI 可随时删 |
| 时区 | **默认 OS** | Node `Intl.DateTimeFormat().resolvedOptions().timeZone`；agent 工具 / UI 默认填入，可显式覆盖 |
| 定位 / geolocation | **不在范围** | 独立 feature，后续单独 brainstorm |

## 3. 架构

```
[ Agent ]                                  [ User UI ]
    │ tool call                               │ REST
    ▼                                         ▼
schedule_create / list / delete         GET / POST / PATCH / DELETE
            │                                 │
            └────────────────┬────────────────┘
                             ▼
                  ScheduleService（归属 cron_jobs）
                  ├─ CRUD（SQLite）
                  └─ SchedulerRegistry add/delete
                             │
                             ▼
              cron_jobs（SQLite，本地优先）
                             │
                             ▼  到点
              ScheduleExecutor.fire(jobId)
                             │
                             ▼
   sessions.appendMessage(sessionId, prompt) + runner.kick(sessionId)
                             │
                             ▼  原会话产出 assistant 回复
              （前端 ws 已订阅时直接看到；离开了下次进去也在 history）
```

进程启动时 `ScheduleExecutor.onApplicationBootstrap`：load 全部 `enabled=true` 的 cron_jobs，按 kind 注册到 `SchedulerRegistry`（cron 用 `addCronJob`、once 用 `addTimeout`）。

## 4. 数据模型

### Entity `CronJob`（owned by `ScheduleService`）

```ts
@Entity("cron_jobs")
export class CronJob {
  @PrimaryColumn() id!: string;                              // ulid

  /** 逻辑外键，无 DB 约束（沿用项目惯例）。 */
  @Column({ name: "session_id" }) sessionId!: string;

  @Column({ type: "varchar" }) kind!: "cron" | "once";

  /** kind === "cron" 时填；"once" 时为 null。 */
  @Column({ name: "cron_expr", type: "varchar", nullable: true })
  cronExpr!: string | null;

  /** kind === "cron" 时填；IANA 时区。 */
  @Column({ type: "varchar", nullable: true })
  timezone!: string | null;

  /** kind === "once" 时填；UTC 时刻。 */
  @Column({ name: "run_at", type: "datetime", nullable: true })
  runAt!: Date | null;

  @Column({ type: "text" }) prompt!: string;
  @Column({ type: "varchar", length: 200 }) title!: string;

  @Column({ type: "boolean", default: true }) enabled!: boolean;

  @Column({ name: "last_fired_at", type: "datetime", nullable: true })
  lastFiredAt!: Date | null;

  /** 派生缓存，主要给列表排序 / 显示「下次触发」。 */
  @Column({ name: "next_fire_at", type: "datetime", nullable: true })
  nextFireAt!: Date | null;

  @CreateDateColumn({ name: "created_at" }) createdAt!: Date;
}
```

### 共享 schema（`libs/types-agent/src/schedule.ts`）

```ts
export const CronJobKindSchema = z.enum(["cron", "once"]);

export const CreateCronJobSchema = z.object({
  sessionId: z.string(),
  title: z.string().min(1).max(200),
  prompt: z.string().min(1),
  kind: CronJobKindSchema,
  cronExpr: z.string().optional(),     // kind="cron" 必填，refine 校验
  timezone: z.string().optional(),     // kind="cron" 必填；缺省取 OS
  runAt: z.string().datetime().optional(), // kind="once" 必填
}).superRefine((v, ctx) => {
  if (v.kind === "cron" && !v.cronExpr) ctx.addIssue({ ... });
  if (v.kind === "once" && !v.runAt) ctx.addIssue({ ... });
});

export const PatchCronJobSchema = z.object({
  enabled: z.boolean().optional(),
  title: z.string().min(1).max(200).optional(),
});

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

export const CronJobListResponseSchema = z.object({
  jobs: z.array(CronJobSchema),
});
```

## 5. cron 表达式 + 时区

- **5 字段标准 cron**（`分 时 日 月 周`），不带秒、不带年；最低粒度 1 分钟。
- 校验 + 算 `nextFireAt` 用 `cron-parser`（轻量、稳定）。
- `timezone` IANA 字符串（如 `Asia/Shanghai`）。`@nestjs/schedule` 的 `addCronJob` 支持 `timeZone` 参数原生兼容。
- **默认值**：agent 工具 / UI 表单 / `date.tool` 缺省时取 `Intl.DateTimeFormat().resolvedOptions().timeZone`。

## 6. 后端服务

### `ScheduleService`（`apps/server-agent/src/services/schedule.service.ts`）

**职责**：CRUD `cron_jobs` + 与 `SchedulerRegistry` 同步。**唯一持有** `@InjectRepository(CronJob)` 的类（过 check:repo）。

公开方法：

| 方法 | 说明 |
|---|---|
| `create(input: CreateCronJobInput): Promise<CronJob>` | 校验 session 存在；ulid 生成 id；算 nextFireAt；落库；enabled=true 时注册到 registry |
| `list(opts?: { sessionId?: string }): Promise<CronJob[]>` | 列表（按 createdAt desc）；可按 sessionId 过滤（agent 工具用） |
| `findById(id): Promise<CronJob>` | 不存在抛 `NotFoundException` |
| `setEnabled(id, enabled): Promise<CronJob>` | 反注册 + 落库 + （重新）注册 |
| `delete(id): Promise<void>` | 反注册 + 删行 |
| `deleteBySession(sessionId): Promise<void>` | session 删除时级联（先反注册所有再 delete） |
| `markFired(id, patch): Promise<void>` | executor 触发后回写 lastFiredAt / nextFireAt / enabled |

### `ScheduleExecutor`（`apps/server-agent/src/services/schedule-executor.service.ts`）

```ts
async onApplicationBootstrap() {
  const all = await this.schedule.list();
  for (const job of all) if (job.enabled) this.register(job);
}

private register(job: CronJob) {
  if (job.kind === "cron") {
    registry.addCronJob(job.id, new CronJob(job.cronExpr!, () => this.fire(job.id), null, true, job.timezone!));
  } else {
    const ms = job.runAt!.getTime() - Date.now();
    if (ms <= 0) {
      // 错过的 one-shot：丢弃 + disable
      void this.schedule.setEnabled(job.id, false);
      return;
    }
    registry.addTimeout(job.id, setTimeout(() => this.fire(job.id), ms));
  }
}

async fire(jobId: string) {
  const job = await this.schedule.findById(jobId);
  if (!job.enabled) return;

  const session = await this.sessions.findOrNull(job.sessionId);
  if (!session) {
    await this.schedule.setEnabled(job.id, false);
    return;
  }

  await this.sessions.appendMessage(job.sessionId, {
    messageId: crypto.randomUUID(),
    content: job.prompt,
  });
  this.runner.kick(job.sessionId);

  if (job.kind === "once") {
    await this.schedule.markFired(job.id, { enabled: false, lastFiredAt: new Date() });
    registry.deleteTimeout(job.id);
  } else {
    const next = cronParser.parseExpression(job.cronExpr!, { tz: job.timezone! }).next().toDate();
    await this.schedule.markFired(job.id, { lastFiredAt: new Date(), nextFireAt: next });
  }
}
```

`ScheduleService` 内部调 `ScheduleExecutor.register` / `deregister` 完成 registry 同步（注入；不让 controller 碰 registry）。

### `CronJobController`（`apps/server-agent/src/controllers/cron-job.controller.ts`）

| 路由 | 说明 |
|---|---|
| `GET /api/cron-jobs?sessionId=...` | 列表（无参 = 全部；带 sessionId = 该会话） |
| `POST /api/cron-jobs` | 创建 |
| `PATCH /api/cron-jobs/:id` | 改 enabled / title |
| `DELETE /api/cron-jobs/:id` | 删除 |

## 7. Agent 工具集（`libs/agent/src/tools/builtins/`）

三个工具，命名 snake_case 对齐现有；`sessionId` 一律从 `ToolContext` 取，schema 不暴露。

### `schedule_create.tool.ts`

```ts
schema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(["cron", "once"]),
  cronExpr: z.string().optional()
    .describe("5-field cron (m h dom mon dow). Required when kind='cron'."),
  runAt: z.string().datetime().optional()
    .describe("ISO 8601 datetime. Required when kind='once'."),
  timezone: z.string().optional()
    .describe("IANA timezone. Defaults to OS timezone (server)."),
  prompt: z.string().min(1)
    .describe("The user message to deliver to this session when the job fires."),
});
```

执行：用 `ctx.sessionId` 作为 sessionId 调 `scheduleService.create`，返回 `{ id, nextFireAt }`。

### `schedule_list.tool.ts`

```ts
schema = z.object({}); // 无参；只列当前 session
```

执行：`scheduleService.list({ sessionId: ctx.sessionId })`。

### `schedule_delete.tool.ts`

```ts
schema = z.object({ id: z.string() });
```

执行：先 `findById(id)` 校验 `job.sessionId === ctx.sessionId`（否则抛错），再 `delete`。

### `date.tool.ts`（改）

`timezone` 改为 **optional**；缺省 = `Intl.DateTimeFormat().resolvedOptions().timeZone`。保留显式覆盖语义。Description 同步更新：「Default = OS timezone」。

## 8. 前端 `/schedule` 页（`apps/web-agent/src/app/schedule/`）

重写当前占位 page，单页：列表卡片 + 「新建」按钮 + 创建 Dialog。**首版无编辑（错就删了重建）**。

### 列表卡片

每行：
- **左**：title（大字号）+ prompt 摘要（1 行省略号）
- **中**：调度信息 — cron 显示原表达式 + 人话翻译（cronstrue，i18n）；once 显示绝对时间
- **右**：状态 chip（启用 / 已停 / 已过期）、下次触发相对时间（「3小时后」）、删除按钮（red ghost）

点 title 区域 → 跳 `/session?id=<sessionId>` 看关联会话。

无任务空态：「没有计划任务。让 agent 帮你创建一个，或点右上角新建」。

### 新建 Dialog

- title（必填）
- session 下拉：默认绑定**最近活跃会话**；可改
- kind 切换（cron / once）
- cron 时：cron 表达式输入 + 实时显示「下次：YYYY-MM-DD HH:mm」预览 + timezone 下拉（默认浏览器时区）
- once 时：datetime-local + timezone（同上默认）
- prompt（textarea）

submit → `POST /api/cron-jobs` → close + 刷列表。

### 操作

- 启用 toggle：`PATCH /api/cron-jobs/:id { enabled }`
- 删除：`DELETE /api/cron-jobs/:id`（confirm 弹窗）

### i18n keys（`schedule.*`）

`title / empty / newJob / kind.cron / kind.once / cronExpr / timezone / runAt / prompt / nextFire / lastFire / enabled / disabled / expired / delete / deleteConfirm / cronPreview / sessionPicker / ...`（zh / en 对称）。

## 9. 不变量 / 边界

- `enabled=false` 的 job **必不在** SchedulerRegistry。
- 任何修改顺序：**先反注册 → 改库 → （视需要）重新注册**。任意一步失败下次启动 reload 即可恢复一致。
- session 删除：`SessionService.delete` 内调 `ScheduleService.deleteBySession(id)`，级联反注册 + 删行（不软删 — 任务无独立保留价值）。
- one-shot 触发后 row 保留供 UI 看「上次执行」；enabled=false 即可。
- cron 触发后 `nextFireAt` 立即重算并落库。
- agent 工具一律绑定当前 sessionId，越权抛错。
- 时区缺省 OS：server 端 `Intl.DateTimeFormat().resolvedOptions().timeZone`。

## 10. 验收

| 场景 | 期望 |
|---|---|
| UI 新建 `0 7 * * *` job | 7:00 准时在指定会话出现一条 user 消息 + assistant 回复 |
| agent 在会话里说「每天 9 点查天气」 | 工具自动调，无确认；`/schedule` 列表看到该 job 绑定到该会话 |
| 手动停用某 job | 不再触发；重新启用 → 下次到点照常触发 |
| 进程重启 | enabled jobs reload 到 registry；cron 下次触发依旧；one-shot 若已过期则自动 disable |
| 关机期间错过 cron 触发点 | 开机后从下一次开始（丢弃中间） |
| 删除会话 | 该会话的所有 jobs 级联反注册 + 删除 |
| `date.tool` 不传 timezone | 返回 server OS 时区时间 |
| 6 围栏 + sync-locales | 全过；`check:repo` 验证 `CronJob` 唯一归属 `ScheduleService` |

## 11. 测试

| 文件 | 覆盖 |
|---|---|
| `schedule.service.spec.ts` | CRUD + registry add/delete + session 越权 |
| `schedule-executor.service.spec.ts` | fire(once)/fire(cron)/session 删除兜底/bootstrap reload/one-shot 过期 disable |
| `cron-job.controller.spec.ts` | 4 REST 端点 + DTO 校验 |
| `schedule-create.tool.spec.ts` | sessionId 自动绑定；cron 表达式必传校验 |
| `schedule-list.tool.spec.ts` | 只列当前 session |
| `schedule-delete.tool.spec.ts` | 越权抛错 |
| `date.tool.spec.ts`（改） | 不传 timezone 走 OS 默认 |

## 12. 不在范围

- agent **修改** 已有 job（删重建）
- agent 操作 / 列举别人会话的 jobs
- 历史触发详情独立表 / 详情页（一字段 `lastFiredAt` 够）
- 任务失败告警通道（依赖 LLM 失败的标准 timeline failed）
- 「补跑」错过的点
- UI 编辑 job
- 定位 / geolocation（独立 feature）
