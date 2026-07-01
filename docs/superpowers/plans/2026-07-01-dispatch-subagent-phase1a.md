# 派子 Agent Phase 1a（后端前台派发）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让主 Agent 通过 `dispatch_subagent` 工具**前台阻塞**派发（可并行 fan-out）一个上下文隔离的子 Agent，子 Agent 作为持久化子会话跑到完成、把结果回给主 Agent 续跑；仅一层嵌套。

**Architecture:** 子 Agent = 一个 `Session`（`kind:"subagent"` + `parentSessionId`/`parentToolCallId`），有自己的 thread_id / SessionMessages。`dispatch_subagent` 是 libs/agent 的 @Tool 薄壳，经 `DISPATCH_SUBAGENT_PORT` 委派给 server-agent 的 `DispatchSubagentService`：建子会话 → `await runner.kickAndWait(subSessionId)` 跑到完成（复用全部 runner/流式/落库机器）→ 读末条 assistant 回传。子 Agent 用**去掉 dispatch 工具的子图**（一层嵌套），由 server-agent 侧按 `session.kind` 把「用子图」标志下传给 GraphRunner。真并行靠把 tools 节点改成并发执行同轮 tool_calls。

**Tech Stack:** NestJS + LangGraph（libs/agent 框架无关编排）、TypeORM/SQLite（server-agent 持久化）、Jest（types-agent / server-agent 单测）、Vitest（libs/agent 单测）。

## Global Constraints

- 子会话就是 `Session`，不新增 Entity；`kind` 枚举加 `"subagent"`；加列 `parent_session_id`、`parent_tool_call_id`。
- 工具名 `dispatch_subagent`；schema `{ task: string, description?: string, model?: string, background?: boolean }`。**Phase 1a 只实现前台（阻塞）分支；`model` 与 `background` 字段先接收但不生效**（留 Phase 2）。
- port token `DISPATCH_SUBAGENT_PORT`（libs/agent 定义，server-agent `@Global` 绑定，与 im_send/ask_question 同款）。
- 前台返回 JSON `{ subSessionId, status:"done"|"error"|"aborted", output }`。
- **仅一层**：子 Agent 用去掉 dispatch 工具的子图；且 `DispatchSubagentService` 额外守卫——父会话本身是 `subagent` 时拒绝派发。
- 并发上限常量 `SUBAGENT_MAX_CONCURRENCY = 4`（账号级信号量）。
- 子 run 步数继承 `MESHBOT_GRAPH_RECURSION_LIMIT`（现有默认 100，无需改）。
- output 回主 LLM 前用现有 `capForLlm`（`TOOL_RESULT_LLM_LIMIT = 32000`）截断。
- libs/agent 纪律：只 `@Injectable` + 生命周期钩子，**禁** `@InjectRepository`/`@Entity`/HTTP/TypeORM；纯逻辑写工厂函数；测试用 vitest。
- 公开方法中文 JSDoc；Biome（`if` 前一行不放注释）；中文 conventional commits + 结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；不 push。
- 全程在 `main` 之外的分支 `feat/dispatch-subagent`（见 Task 0）。**只跑本任务相关测试**，全量套件与 boot 留 Task 8。

---

## File Structure

**新建：**
- `libs/types-agent/src/dispatch-subagent.ts` — dispatch schema + 类型。
- `libs/types-agent/src/dispatch-subagent.spec.ts` — schema 单测（jest）。
- `libs/agent/src/tools/dispatch-subagent.port.ts` — port token + 接口。
- `libs/agent/src/tools/builtins/dispatch-subagent.tool.ts` — @Tool 薄壳。
- `libs/agent/src/tools/builtins/dispatch-subagent.tool.spec.ts` — 薄壳单测（vitest）。
- `apps/server-agent/src/migrations/1780700000000-AddSessionParentLinkage.ts` — 加 parent 列。
- `apps/server-agent/src/services/dispatch-subagent.service.ts` — port 实现。
- `apps/server-agent/src/services/dispatch-subagent.service.spec.ts` — 单测（jest）。
- `apps/server-agent/src/dispatch-subagent.module.ts` — @Global 绑定 port。

**修改：**
- `libs/types-agent/src/index.ts` — 导出 dispatch schema。
- `libs/types-agent/src/session.ts` — 加 `runSubagentSpawned` 事件常量 + payload 类型。
- `apps/server-agent/src/entities/session.entity.ts` — 加 parent 列 + kind 加 subagent。
- `apps/server-agent/src/services/session.service.ts` — `createSubSession`。
- `apps/server-agent/src/services/session-message.service.ts` — `findLastAssistant`。
- `libs/agent/src/graph/graph.builder.ts` — `buildSupervisorGraph` 加可选 `excludeToolNames`。
- `libs/agent/src/graph/account-graph.provider.ts` — `subAgentGraph()`。
- `libs/agent/src/graph/nodes/tools.node.ts` — 同轮 tool_calls 改并发。
- `libs/agent/src/graph/graph-runner.service.ts` — streamMessage/resumeStream/runGraphStream 接受 `{ subAgent }`，按此选子图。
- `apps/server-agent/src/services/runner.service.ts` — 按 session.kind 把 `subAgent` 标志下传 GraphRunner。
- `apps/server-agent/src/agent.module.ts`（或工具注册模块）— 注册 dispatch tool provider。
- `apps/server-agent/src/ws/session.gateway.ts` — `@OnEvent(runSubagentSpawned)` 转发到父房间。
- `apps/server-agent/src/app.module.ts` — 导入 `DispatchSubagentModule`。

---

## Task 0: 准备分支

- [ ] **Step 1: 从 main 切分支**

```bash
cd /Users/grant/Meta1/meshbot
git checkout main
git checkout -b feat/dispatch-subagent
git status
```
Expected: 在 `feat/dispatch-subagent`，未跟踪含本次 spec/plan 文件。首个提交把 spec+plan 一起提交：
```bash
git add docs/superpowers/specs/2026-07-01-dispatch-subagent-design.md docs/superpowers/plans/2026-07-01-dispatch-subagent-phase1a.md
git commit -m "docs: 派子 Agent 设计 spec + Phase 1a 实施 plan

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: types-agent — dispatch schema + spawned 事件

**Files:**
- Create: `libs/types-agent/src/dispatch-subagent.ts`
- Create: `libs/types-agent/src/dispatch-subagent.spec.ts`
- Modify: `libs/types-agent/src/index.ts`
- Modify: `libs/types-agent/src/session.ts`

**Interfaces:**
- Produces:
  - `dispatchSubagentSchema: z.ZodType<{ task: string; description?: string; model?: string; background?: boolean }>`，`DispatchSubagentInput` 类型。
  - `session.ts`：`SESSION_WS_EVENTS.runSubagentSpawned = "run.subagent_spawned"`，`RunSubagentSpawnedEvent = { sessionId: string; toolCallId: string; subSessionId: string; description: string }`。

- [ ] **Step 1: 写失败的 schema 单测**

`libs/types-agent/src/dispatch-subagent.spec.ts`:
```ts
import { dispatchSubagentSchema } from "./dispatch-subagent";

describe("dispatchSubagentSchema", () => {
  it("最简：仅 task 通过", () => {
    const r = dispatchSubagentSchema.parse({ task: "查一下 X" });
    expect(r.task).toBe("查一下 X");
    expect(r.background).toBe(false);
  });

  it("含可选字段通过", () => {
    const r = dispatchSubagentSchema.parse({
      task: "t",
      description: "d",
      model: "m1",
      background: true,
    });
    expect(r).toEqual({ task: "t", description: "d", model: "m1", background: true });
  });

  it("缺 task 报错", () => {
    expect(() => dispatchSubagentSchema.parse({})).toThrow();
  });

  it("task 空串报错", () => {
    expect(() => dispatchSubagentSchema.parse({ task: "" })).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- libs/types-agent/src/dispatch-subagent.spec.ts`
Expected: FAIL，`Cannot find module './dispatch-subagent'`。

- [ ] **Step 3: 实现 schema**

`libs/types-agent/src/dispatch-subagent.ts`:
```ts
import { z } from "zod";

/**
 * dispatch_subagent 工具入参。
 * - task：子任务完整指令（作为子 Agent 的初始 user 消息）。
 * - description：短标题（用于前端嵌套卡显示；缺省用 task 截断）。
 * - model：可选，ModelConfig id/名（Phase 2 生效；Phase 1a 忽略，用父 run 活跃模型）。
 * - background：默认 false=前台阻塞（Phase 2 才实现 true 后台）。
 */
export const dispatchSubagentSchema = z.object({
  task: z.string().min(1),
  description: z.string().optional(),
  model: z.string().optional(),
  background: z.boolean().default(false),
});

export type DispatchSubagentInput = z.infer<typeof dispatchSubagentSchema>;
```

- [ ] **Step 4: 加 spawned 事件到 session.ts**

在 `libs/types-agent/src/session.ts` 的 `SESSION_WS_EVENTS` 对象里追加一项（与现有 `runToolCallStart` 等同级，值用 `"run.subagent_spawned"`）：
```ts
  runSubagentSpawned: "run.subagent_spawned",
```
并在该文件事件 payload 类型区（与 `RunToolCallEndEvent` 等相邻）追加：
```ts
/** 子 Agent 派发关联事件：让前端把父消息里某个 dispatch 工具卡认领到子会话。 */
export interface RunSubagentSpawnedEvent {
  /** 父会话 id（事件按此路由到父房间）。 */
  sessionId: string;
  /** 父会话里那次 dispatch 工具调用的 toolCallId。 */
  toolCallId: string;
  /** 子会话 id（前端据此订阅嵌套流）。 */
  subSessionId: string;
  /** 子任务短标题。 */
  description: string;
}
```

- [ ] **Step 5: 导出 schema**

在 `libs/types-agent/src/index.ts` 追加：
```ts
export * from "./dispatch-subagent";
```
（`session.ts` 已被 index 导出，事件类型自动可用；若 index 是逐项导出，按现有风格补 `RunSubagentSpawnedEvent`。）

- [ ] **Step 6: 运行确认通过**

Run: `pnpm test -- libs/types-agent/src/dispatch-subagent.spec.ts`
Expected: PASS（4 例）。

- [ ] **Step 7: typecheck + 提交**

Run: `pnpm --filter @meshbot/types-agent typecheck`
Expected: 无错误。
```bash
git add libs/types-agent/src/dispatch-subagent.ts libs/types-agent/src/dispatch-subagent.spec.ts libs/types-agent/src/index.ts libs/types-agent/src/session.ts
git commit -m "feat(types-agent): dispatch_subagent schema + subagent_spawned 事件类型

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Session 数据模型 + createSubSession + findLastAssistant

**Files:**
- Modify: `apps/server-agent/src/entities/session.entity.ts`
- Create: `apps/server-agent/src/migrations/1780700000000-AddSessionParentLinkage.ts`
- Modify: `apps/server-agent/src/services/session.service.ts`
- Modify: `apps/server-agent/src/services/session-message.service.ts`
- Test: `apps/server-agent/src/services/session.service.spec.ts`（已存在，追加用例）

**Interfaces:**
- Consumes: `createSubSession` 复用现有 `createSession` 的 @Transactional「建 Session + 首条 pending」模式。
- Produces:
  - `SessionService.createSubSession(input: { parentSessionId: string; parentToolCallId: string; task: string; description?: string }): Promise<{ subSessionId: string }>`
  - `SessionMessageService.findLastAssistant(sessionId: string): Promise<{ content: string } | null>`

- [ ] **Step 1: 改 entity（加列 + kind 加 subagent）**

`apps/server-agent/src/entities/session.entity.ts`，把：
```ts
  @Column({ type: "varchar", default: "user" })
  kind!: "user" | "quick";
```
改为：
```ts
  @Column({ type: "varchar", default: "user" })
  kind!: "user" | "quick" | "subagent";

  @Column({ name: "parent_session_id", type: "text", nullable: true })
  parentSessionId!: string | null;

  @Column({ name: "parent_tool_call_id", type: "text", nullable: true })
  parentToolCallId!: string | null;
```

- [ ] **Step 2: 写迁移**

`apps/server-agent/src/migrations/1780700000000-AddSessionParentLinkage.ts`:
```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * sessions 表加 parent_session_id / parent_tool_call_id —— 子 Agent 子会话
 * 关联父会话与那次 dispatch 工具调用。两列均可空（普通会话为 NULL）。
 */
export class AddSessionParentLinkage1780700000000 implements MigrationInterface {
  name = "AddSessionParentLinkage1780700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "parent_session_id" TEXT`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "parent_tool_call_id" TEXT`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_sessions_parent" ON "sessions" ("parent_session_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sessions_parent"`);
    // SQLite 不支持 DROP COLUMN；本地轨保留列即可（与既有迁移一致）
  }
}
```
（迁移文件需在 data-source 的 migrations 数组注册——按仓库现有做法：迁移目录通配自动加载。若是显式数组，追加本类。核对 `apps/server-agent/src/data-source*.ts` 的 migrations 配置。）

- [ ] **Step 3: 写失败的 createSubSession 单测**

在 `apps/server-agent/src/services/session.service.spec.ts` 追加（沿用该文件现有的 in-memory sqlite + 账号上下文夹具；如夹具变量名不同按文件实际调整）：
```ts
it("createSubSession 建 subagent 会话并带 parent 关联 + 首条 pending", async () => {
  const parent = await service.createSession({ content: "父任务" });
  const { subSessionId } = await service.createSubSession({
    parentSessionId: parent.sessionId,
    parentToolCallId: "tc-1",
    task: "子任务内容",
    description: "子任务",
  });
  const sub = await service.findOrNull(subSessionId);
  expect(sub?.kind).toBe("subagent");
  expect(sub?.parentSessionId).toBe(parent.sessionId);
  expect(sub?.parentToolCallId).toBe("tc-1");
  const pend = await service.listActivePending(subSessionId);
  expect(pend.map((p) => p.content)).toContain("子任务内容");
});

it("listAllSorted 不含 subagent 会话", async () => {
  const parent = await service.createSession({ content: "父" });
  await service.createSubSession({
    parentSessionId: parent.sessionId,
    parentToolCallId: "tc",
    task: "子",
  });
  const all = await service.listAllSorted();
  const kinds = new Set(all.map((s) => s.id));
  expect(kinds.has(parent.sessionId)).toBe(true);
});
```

- [ ] **Step 4: 运行确认失败**

Run: `pnpm test -- apps/server-agent/src/services/session.service.spec.ts`
Expected: FAIL，`createSubSession is not a function`。

- [ ] **Step 5: 实现 createSubSession**

在 `apps/server-agent/src/services/session.service.ts` 加（放在 `createSessionInTx` 之后，复用同款 @Transactional 跨表写；标题取 description 或 task 截断，注意 `TITLE_MAX`）：
```ts
  /**
   * 建子 Agent 子会话：Session(kind:"subagent" + parent 关联, running) + 首条 pending(task)。
   * 跨两表写入，@Transactional 包裹。须在父 run 账号上下文内调用（作用域仓库自动盖 cloudUserId）。
   */
  async createSubSession(input: {
    parentSessionId: string;
    parentToolCallId: string;
    task: string;
    description?: string;
  }): Promise<{ subSessionId: string }> {
    return this.createSubSessionInTx(input);
  }

  @Transactional()
  private async createSubSessionInTx(input: {
    parentSessionId: string;
    parentToolCallId: string;
    task: string;
    description?: string;
  }): Promise<{ subSessionId: string }> {
    const title = (input.description ?? stripLlmuse(input.task)).slice(
      0,
      TITLE_MAX,
    );
    const saved = (await this.sessionRepo.save({
      title,
      status: "running" as const,
      kind: "subagent" as const,
      parentSessionId: input.parentSessionId,
      parentToolCallId: input.parentToolCallId,
    })) as Session;
    await this.pendingRepo.save({
      sessionId: saved.id,
      content: input.task,
      status: "pending" as const,
    });
    return { subSessionId: saved.id };
  }
```

- [ ] **Step 6: 实现 findLastAssistant**

在 `apps/server-agent/src/services/session-message.service.ts` 加（沿用该文件现有作用域仓库；按 seq 倒序取首条 role=assistant）：
```ts
  /** 取某会话末条 assistant 消息内容；无则 null。供子 Agent 回传 output 用。 */
  async findLastAssistant(sessionId: string): Promise<{ content: string } | null> {
    const row = await this.messageRepo
      .scopedQueryBuilder("m")
      .andWhere("m.session_id = :sessionId", { sessionId })
      .andWhere("m.role = :role", { role: "assistant" })
      .orderBy("m.seq", "DESC")
      .limit(1)
      .getOne();
    return row ? { content: row.content } : null;
  }
```
（作用域仓库字段名以该文件实际为准——若持有 `this.repo`/别的名，改用之；`scopedQueryBuilder` 与 SessionService 同款。）

- [ ] **Step 7: 运行确认通过 + typecheck**

Run: `pnpm test -- apps/server-agent/src/services/session.service.spec.ts`
Expected: PASS（含 2 新例）。
Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 无错误。

- [ ] **Step 8: 提交**

```bash
git add apps/server-agent/src/entities/session.entity.ts apps/server-agent/src/migrations/1780700000000-AddSessionParentLinkage.ts apps/server-agent/src/services/session.service.ts apps/server-agent/src/services/session-message.service.ts apps/server-agent/src/services/session.service.spec.ts
git commit -m "feat(server-agent): Session 加 parent 关联 + subagent kind，createSubSession/findLastAssistant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 子图 — buildSupervisorGraph excludeToolNames + subAgentGraph

**Files:**
- Modify: `libs/agent/src/graph/graph.builder.ts`
- Modify: `libs/agent/src/graph/account-graph.provider.ts`
- Test: `libs/agent/src/graph/account-graph.provider.spec.ts`（新建或追加）

**Interfaces:**
- Consumes: `ToolRegistry.asLangChainBindable()`（返回全部 bindable LC tools）。
- Produces:
  - `filterBindable(tools, excludeToolNames?): StructuredToolInterface[]` — 导出的纯函数，按名字排除。
  - `buildSupervisorGraph(checkpointer, modelProvider, registry, emitter, resolveMessageId, excludeToolNames?: ReadonlySet<string>)` — 多一个可选参数，supervisor 绑定的工具经 `filterBindable` 过滤。
  - `AccountGraphProvider.subAgentGraph(): { graph }` — 缓存的子图（排除 `dispatch_subagent`），共用同账号 checkpointer。

- [ ] **Step 1: 写失败的 filterBindable 单测**

`libs/agent/src/graph/graph.builder.spec.ts`（新建，vitest；测真正被 buildSupervisorGraph 使用的过滤函数，非恒真）：
```ts
import { describe, expect, it } from "vitest";
import { filterBindable } from "./graph.builder";

const t = (name: string) => ({ name }) as never;

describe("filterBindable", () => {
  it("无排除集时原样返回", () => {
    const tools = [t("a"), t("b")];
    expect(filterBindable(tools).map((x) => x.name)).toEqual(["a", "b"]);
  });

  it("按名字排除指定工具", () => {
    const tools = [t("a"), t("dispatch_subagent"), t("b")];
    const out = filterBindable(tools, new Set(["dispatch_subagent"]));
    expect(out.map((x) => x.name)).toEqual(["a", "b"]);
  });

  it("排除集非空但无命中时原样返回", () => {
    const tools = [t("a"), t("b")];
    expect(
      filterBindable(tools, new Set(["nope"])).map((x) => x.name),
    ).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meshbot/agent test -- graph.builder.spec.ts`
Expected: FAIL（`filterBindable` 未导出）。

- [ ] **Step 3: 实现 filterBindable + 接入 buildSupervisorGraph**

`libs/agent/src/graph/graph.builder.ts`：顶部（`import` 后）加导出的纯函数（`StructuredToolInterface` 从 `@langchain/core/tools` import）：
```ts
import type { StructuredToolInterface } from "@langchain/core/tools";

/** 按名字过滤 bindable 工具列表（子 Agent 用来排除 dispatch_subagent，实现一层嵌套）。 */
export function filterBindable(
  tools: StructuredToolInterface[],
  excludeToolNames?: ReadonlySet<string>,
): StructuredToolInterface[] {
  if (!excludeToolNames || excludeToolNames.size === 0) return tools;
  return tools.filter((t) => !excludeToolNames.has(t.name));
}
```
把 `buildSupervisorGraph` 签名与 supervisor 构造改为：
```ts
export function buildSupervisorGraph(
  checkpointer: SqliteSaver,
  modelProvider: ModelProvider,
  registry: ToolRegistry,
  emitter: EventEmitter2,
  resolveMessageId: (modelId: string) => string,
  excludeToolNames?: ReadonlySet<string>,
) {
  const supervisor = createSupervisorNode(
    modelProvider,
    () => filterBindable(registry.asLangChainBindable(), excludeToolNames),
    resolveMessageId,
  );
  const tools = createToolsNode(registry, emitter);
  // ……其余不变（addNode/addEdge/compile）……
```
（其余函数体不变。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @meshbot/agent test -- graph.builder.spec.ts`
Expected: PASS（3 例）。真正「子图 supervisor 不绑 dispatch」的端到端由 Task 8 boot 覆盖；此单测锁定过滤函数正确。

- [ ] **Step 5: account-graph.provider 加 subAgentGraph**

`libs/agent/src/graph/account-graph.provider.ts`：加一个并行缓存 + 方法。在类里加字段与方法：
```ts
  /** 子 Agent 子图（排除 dispatch_subagent），按账号缓存，共用同账号 checkpointer。 */
  private readonly subGraphsByAccount = new Map<
    string,
    { graph: ReturnType<typeof buildSupervisorGraph> }
  >();

  /** 排除集：子 Agent 不绑定 dispatch 工具，天然不能再派（一层）。 */
  private static readonly SUBAGENT_EXCLUDE = new Set(["dispatch_subagent"]);

  /** 解析当前账号的子图（复用 accountGraph 的 checkpointer；首次建、之后缓存）。 */
  subAgentGraph(): { graph: ReturnType<typeof buildSupervisorGraph> } {
    const acct = this.account.getOrThrow();
    let entry = this.subGraphsByAccount.get(acct);
    if (!entry) {
      const { checkpointer } = this.accountGraph();
      const graph = buildSupervisorGraph(
        checkpointer,
        this.modelResolver.provider(),
        this.toolRegistry,
        this.eventEmitter,
        this.resolveMessageId,
        AccountGraphProvider.SUBAGENT_EXCLUDE,
      );
      entry = { graph };
      this.subGraphsByAccount.set(acct, entry);
    }
    return entry;
  }
```

- [ ] **Step 6: typecheck + 提交**

Run: `pnpm --filter @meshbot/agent typecheck`
Expected: 无错误。
```bash
git add libs/agent/src/graph/graph.builder.ts libs/agent/src/graph/account-graph.provider.ts libs/agent/src/graph/graph.builder.spec.ts
git commit -m "feat(agent): 子 Agent 子图（buildSupervisorGraph excludeToolNames + subAgentGraph）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: tools 节点并发 fan-out

**Files:**
- Modify: `libs/agent/src/graph/nodes/tools.node.ts`
- Test: `libs/agent/src/graph/nodes/tools.node.spec.ts`（已存在，追加）

**Interfaces:**
- Produces（行为变更）：`toolsNode` 把同轮多个 tool_calls **并发执行**（`Promise.all`），结果按原 tool_calls 顺序 append，保持每个 `tool_call → ToolMessage` 配对。

- [ ] **Step 1: 写失败的并发单测**

在 `libs/agent/src/graph/nodes/tools.node.spec.ts` 追加（vitest；两个工具，一个慢一个快，验证并发——总耗时 ≈ 慢的那个，且结果按调用顺序）：
```ts
it("同轮多个 tool_calls 并发执行且结果保序", async () => {
  const order: string[] = [];
  const registry = {
    get: (name: string) => ({
      name,
      description: "",
      schema: { parse: (a: unknown) => a },
      execute: async () => {
        const delay = name === "slow" ? 60 : 10;
        await new Promise((r) => setTimeout(r, delay));
        order.push(name);
        return `${name}-result`;
      },
    }),
  } as unknown as import("../../tools/tool-registry").ToolRegistry;
  const emitter = { emit: () => true } as unknown as import("@nestjs/event-emitter").EventEmitter2;
  const node = createToolsNode(registry, emitter);
  const state = {
    messages: [
      {
        id: "m1",
        tool_calls: [
          { id: "c1", name: "slow", args: {} },
          { id: "c2", name: "fast", args: {} },
        ],
      } as never,
    ],
  };
  const start = Date.now();
  const out = (await node(state as never, {
    configurable: { thread_id: "s1" },
    signal: new AbortController().signal,
  } as never)) as { messages: Array<{ tool_call_id: string; content: string }> };
  const elapsed = Date.now() - start;
  // 并发：总耗时接近慢的（~60ms），远小于串行（~70ms+）；放宽到 <120ms 容错
  expect(elapsed).toBeLessThan(120);
  // 保序：结果数组仍按 tool_calls 顺序（slow=c1 在前）
  expect(out.messages.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
  // fast 先完成（order[0]="fast"）证明确实并发而非串行
  expect(order[0]).toBe("fast");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meshbot/agent test -- tools.node.spec.ts`
Expected: FAIL（当前串行：`order[0]` 会是 "slow"，或耗时断言失败）。

- [ ] **Step 3: 改并发实现**

`libs/agent/src/graph/nodes/tools.node.ts`，把 `const results: ToolMessage[] = []; for (const call of toolCalls) { … }` 整段循环替换为「先把每个 call 映射成一个 async 任务，`Promise.all` 并发，结果按序收集」。即把原来 for 循环体抽成 `async (call) => ToolMessage`，然后：
```ts
    const runOne = async (call: {
      id?: string;
      name: string;
      args: unknown;
    }): Promise<ToolMessage> => {
      const toolCallId = call.id ?? "";
      const tool = registry.get(call.name);
      if (!tool) {
        return new ToolMessage({
          tool_call_id: toolCallId,
          name: call.name,
          content: `Error: unknown tool ${call.name}`,
        });
      }
      const ctx: ToolContext = { sessionId, messageId, toolCallId, emitter, signal };
      emitter.emit(SESSION_WS_EVENTS.runToolCallStart, {
        sessionId,
        messageId,
        toolCallId,
        name: call.name,
        args: call.args,
      });
      let content: string;
      let ok = true;
      try {
        const parsed = tool.schema.parse(call.args);
        const result = await tool.execute(parsed as never, ctx);
        content = typeof result === "string" ? result : JSON.stringify(result);
      } catch (err) {
        ok = false;
        content = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      const llmContent = capForLlm(content);
      emitter.emit(SESSION_WS_EVENTS.runToolCallEnd, {
        sessionId,
        messageId,
        toolCallId,
        name: call.name,
        ok,
        resultPreview: content.slice(0, RESULT_PREVIEW_LIMIT),
        content,
      });
      return new ToolMessage({
        tool_call_id: toolCallId,
        name: call.name,
        content: llmContent,
      });
    };
    // 同轮 tool_calls 并发执行（相互独立）；Promise.all 保持数组顺序 = tool_calls 顺序，
    // 保证每个 tool_call → 对应 ToolMessage 配对与顺序不乱。
    const results = await Promise.all(toolCalls.map(runOne));
    return { messages: results };
```
（`capForLlm` / `RESULT_PREVIEW_LIMIT` / `SESSION_WS_EVENTS` 等既有引用不变。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @meshbot/agent test -- tools.node.spec.ts`
Expected: PASS（含新并发例 + 原有用例不回归）。

- [ ] **Step 5: 提交**

```bash
git add libs/agent/src/graph/nodes/tools.node.ts libs/agent/src/graph/nodes/tools.node.spec.ts
git commit -m "feat(agent): tools 节点同轮 tool_calls 改并发执行（保序），支撑并行 fan-out

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: GraphRunner 子图选择 + RunnerService 传 subAgent 标志

**Files:**
- Modify: `libs/agent/src/graph/graph-runner.service.ts`
- Modify: `apps/server-agent/src/services/runner.service.ts`

**Interfaces:**
- Consumes: `AccountGraphProvider.subAgentGraph()`（Task 3）、`SessionService.findOrNull`（读 kind）。
- Produces:
  - `GraphRunner.streamMessage(threadId, inputs, signal, opts?: { subAgent?: boolean })` / `resumeStream(threadId, signal, opts?)` — `subAgent:true` 时用子图。
  - RunnerService 在 `runOnce`/`consumeRunStream` 传 `subAgent`（按 session.kind === "subagent" 判定）。

- [ ] **Step 1: GraphRunner 接受 subAgent 并选图**

`libs/agent/src/graph/graph-runner.service.ts`：
1. `streamMessage` / `streamMessageImpl` / `resumeStream` / `runGraphStream` 各加末位可选参 `opts?: { subAgent?: boolean }`，逐层透传。
2. 抽一个私有取图：
```ts
  private pickGraph(opts?: { subAgent?: boolean }) {
    return opts?.subAgent
      ? this.accountGraphProvider.subAgentGraph().graph
      : this.accountGraphProvider.accountGraph().graph;
  }
```
3. `streamMessageImpl` 里 `this.accountGraphProvider.accountGraph().graph.getState(...)` → `this.pickGraph(opts).getState(...)`；`runGraphStream` 里 `this.accountGraphProvider.accountGraph().graph.stream(...)` → `this.pickGraph(opts).stream(...)`。
（`resolveMessageId` / `deleteMsgIds` 仍走 `accountGraphProvider`——msgIdMap 是全局的，与用哪张图无关，不改。）

- [ ] **Step 2: RunnerService 判 kind 并下传**

`apps/server-agent/src/services/runner.service.ts`：`consumeRunStream` 内构造 stream 处，先取 session kind（该方法已在账号上下文内，`this.sessions.findOrNull(sessionId)` 可用），把 `{ subAgent }` 传给 graphRunner：
```ts
    const session = await this.sessions.findOrNull(sessionId);
    const subAgent = session?.kind === "subagent";
    const stream = resume
      ? this.graphRunner.resumeStream(sessionId, run.abort.signal, { subAgent })
      : this.graphRunner.streamMessage(sessionId, batch, run.abort.signal, {
          subAgent,
        });
```
（其余 consumeRunStream 逻辑不变。`SessionService` 已注入为 `this.sessions`。）

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meshbot/agent typecheck && pnpm --filter @meshbot/server-agent typecheck`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add libs/agent/src/graph/graph-runner.service.ts apps/server-agent/src/services/runner.service.ts
git commit -m "feat(agent): 子会话按 kind 选子图（GraphRunner subAgent 选图 + RunnerService 下传）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> 说明：本任务是图选择接线，端到端由 Task 7（DispatchSubagentService 跑子会话）+ Task 8（boot）验证；此处以 typecheck 为关卡，不强造集成单测（会牵动整套 graph mock）。

---

## Task 6: dispatch port + tool（libs/agent）

**Files:**
- Create: `libs/agent/src/tools/dispatch-subagent.port.ts`
- Create: `libs/agent/src/tools/builtins/dispatch-subagent.tool.ts`
- Create: `libs/agent/src/tools/builtins/dispatch-subagent.tool.spec.ts`
- Modify: `libs/agent/src/agent.module.ts`（注册 provider）
- Modify: `libs/agent/src/index.ts`（导出 port token/接口）

**Interfaces:**
- Consumes: `DispatchSubagentInput`（Task 1）、`ToolContext`。
- Produces:
  - `DISPATCH_SUBAGENT_PORT = Symbol("DISPATCH_SUBAGENT_PORT")`
  - `DispatchSubagentPort.dispatch(params, signal): Promise<string>`，`params = { parentSessionId; parentToolCallId; task; description?; model?; background? }`。
  - `DispatchSubagentTool`（@Tool，name `dispatch_subagent`）。

- [ ] **Step 1: 写 port**

`libs/agent/src/tools/dispatch-subagent.port.ts`:
```ts
/**
 * DISPATCH_SUBAGENT_PORT —— libs/agent → server-agent 解耦端口（派子 Agent）。
 *
 * dispatch_subagent 工具经此端口把子任务委派给一个隔离子会话；server-agent 实现
 * 负责建子会话、跑到完成、回传结果。无 server-agent 环境（测试）可不注入。
 */
export const DISPATCH_SUBAGENT_PORT = Symbol("DISPATCH_SUBAGENT_PORT");

/** 派子 Agent 端口。 */
export interface DispatchSubagentPort {
  /**
   * 派发子 Agent。Phase 1a 仅前台（阻塞至完成）。返回 JSON 字符串：
   * {"subSessionId","status":"done"|"error"|"aborted","output"}
   */
  dispatch(
    params: {
      parentSessionId: string;
      parentToolCallId: string;
      task: string;
      description?: string;
      model?: string;
      background?: boolean;
    },
    signal: AbortSignal,
  ): Promise<string>;
}
```

- [ ] **Step 2: 写失败的 tool 薄壳单测**

`libs/agent/src/tools/builtins/dispatch-subagent.tool.spec.ts`（vitest；验证从 ctx 透传 + 调 port）：
```ts
import { describe, expect, it, vi } from "vitest";
import { DispatchSubagentTool } from "./dispatch-subagent.tool";

describe("DispatchSubagentTool", () => {
  it("从 ctx 取 parentSessionId/parentToolCallId 并透传 args + signal 给 port", async () => {
    const dispatch = vi.fn().mockResolvedValue('{"status":"done"}');
    const tool = new DispatchSubagentTool({ dispatch } as never);
    const signal = new AbortController().signal;
    const res = await tool.execute(
      { task: "t", description: "d", background: false },
      { sessionId: "parent", toolCallId: "tc", messageId: "m", emitter: {} as never, signal },
    );
    expect(res).toBe('{"status":"done"}');
    expect(dispatch).toHaveBeenCalledWith(
      {
        parentSessionId: "parent",
        parentToolCallId: "tc",
        task: "t",
        description: "d",
        model: undefined,
        background: false,
      },
      signal,
    );
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @meshbot/agent test -- dispatch-subagent.tool.spec.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 写 tool 薄壳**

`libs/agent/src/tools/builtins/dispatch-subagent.tool.ts`:
```ts
import {
  type DispatchSubagentInput,
  dispatchSubagentSchema,
} from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import {
  DISPATCH_SUBAGENT_PORT,
  type DispatchSubagentPort,
} from "../dispatch-subagent.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class DispatchSubagentTool
  implements MeshbotTool<DispatchSubagentInput, string>
{
  readonly name = "dispatch_subagent";
  readonly description =
    "Delegate a self-contained sub-task to a fresh, context-isolated sub-agent. " +
    "The sub-agent has the same tools but starts from a clean context with only your " +
    "`task` prompt, runs to completion, and returns a JSON result {subSessionId,status,output}. " +
    "Use to decompose large tasks or keep your own context clean. You may call it multiple " +
    "times in one turn to run sub-agents in parallel. Sub-agents cannot dispatch further.";
  readonly schema = dispatchSubagentSchema;

  constructor(
    @Inject(DISPATCH_SUBAGENT_PORT) private readonly port: DispatchSubagentPort,
  ) {}

  /** 把子任务委派给子 Agent；前台阻塞至完成，返回 {subSessionId,status,output} JSON。 */
  execute(args: DispatchSubagentInput, ctx: ToolContext): Promise<string> {
    return this.port.dispatch(
      {
        parentSessionId: ctx.sessionId,
        parentToolCallId: ctx.toolCallId,
        task: args.task,
        description: args.description,
        model: args.model,
        background: args.background,
      },
      ctx.signal,
    );
  }
}
```

- [ ] **Step 5: 注册 provider + 导出**

在 `libs/agent/src/agent.module.ts` 的 providers 里加入 `DispatchSubagentTool`（与其它 builtin @Tool 同处；按现有 import/providers 风格加）。在 `libs/agent/src/index.ts` 导出：
```ts
export * from "./tools/dispatch-subagent.port";
```

- [ ] **Step 6: 运行确认通过 + typecheck**

Run: `pnpm --filter @meshbot/agent test -- dispatch-subagent.tool.spec.ts`
Expected: PASS。
Run: `pnpm --filter @meshbot/agent typecheck`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add libs/agent/src/tools/dispatch-subagent.port.ts libs/agent/src/tools/builtins/dispatch-subagent.tool.ts libs/agent/src/tools/builtins/dispatch-subagent.tool.spec.ts libs/agent/src/agent.module.ts libs/agent/src/index.ts
git commit -m "feat(agent): dispatch_subagent 工具薄壳 + DISPATCH_SUBAGENT_PORT

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: DispatchSubagentService + module + gateway 转发（前台派发）

**Files:**
- Create: `apps/server-agent/src/services/dispatch-subagent.service.ts`
- Create: `apps/server-agent/src/services/dispatch-subagent.service.spec.ts`
- Create: `apps/server-agent/src/dispatch-subagent.module.ts`
- Modify: `apps/server-agent/src/ws/session.gateway.ts`
- Modify: `apps/server-agent/src/app.module.ts`

**Interfaces:**
- Consumes: `SessionService.createSubSession/findOrNull`、`SessionMessageService.findLastAssistant`、`RunnerService.kickAndWait/interrupt`、`AccountContextService`、`EventEmitter2`、`DispatchSubagentPort`（实现它）。
- Produces: `DispatchSubagentService implements DispatchSubagentPort`；`@Global DispatchSubagentModule` 绑 `{ provide: DISPATCH_SUBAGENT_PORT, useExisting: DispatchSubagentService }`。

- [ ] **Step 1: 写失败的 service 单测**

`apps/server-agent/src/services/dispatch-subagent.service.spec.ts`（jest；mock 依赖，验证：建子会话→kickAndWait→读末条 assistant→返回 done+output；一层守卫；并发信号量）：
```ts
import { DispatchSubagentService } from "./dispatch-subagent.service";

function make(overrides?: Partial<Record<string, unknown>>) {
  const sessions = {
    createSubSession: jest.fn().mockResolvedValue({ subSessionId: "sub-1" }),
    findOrNull: jest.fn().mockResolvedValue({ id: "parent", kind: "user" }),
  };
  const messages = {
    findLastAssistant: jest.fn().mockResolvedValue({ content: "子答案" }),
  };
  const runner = { kickAndWait: jest.fn().mockResolvedValue(undefined), interrupt: jest.fn() };
  const emitter = { emit: jest.fn() };
  const account = { getOrThrow: jest.fn().mockReturnValue("u1") };
  const svc = new DispatchSubagentService(
    sessions as never,
    messages as never,
    runner as never,
    emitter as never,
    account as never,
  );
  return { svc, sessions, messages, runner, emitter, account, ...overrides };
}

describe("DispatchSubagentService.dispatch（前台）", () => {
  it("建子会话→跑到完成→回传末条 assistant", async () => {
    const { svc, sessions, runner, emitter } = make();
    const out = await svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc", task: "查 X", description: "查X" },
      new AbortController().signal,
    );
    expect(sessions.createSubSession).toHaveBeenCalled();
    expect(runner.kickAndWait).toHaveBeenCalledWith("sub-1");
    // 建好子会话即在父房间发 spawned 关联事件
    expect(emitter.emit).toHaveBeenCalledWith(
      "run.subagent_spawned",
      expect.objectContaining({ sessionId: "parent", toolCallId: "tc", subSessionId: "sub-1" }),
    );
    expect(JSON.parse(out)).toEqual({ subSessionId: "sub-1", status: "done", output: "子答案" });
  });

  it("父会话本身是 subagent 时拒绝（一层）", async () => {
    const { svc, sessions } = make();
    sessions.findOrNull.mockResolvedValue({ id: "parent", kind: "subagent" });
    const out = await svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc", task: "t" },
      new AbortController().signal,
    );
    expect(JSON.parse(out).status).toBe("error");
    expect(sessions.createSubSession).not.toHaveBeenCalled();
  });

  it("已 aborted 的 signal 直接返回 aborted，不跑", async () => {
    const { svc, runner } = make();
    const ac = new AbortController();
    ac.abort();
    const out = await svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc", task: "t" },
      ac.signal,
    );
    expect(JSON.parse(out).status).toBe("aborted");
    expect(runner.kickAndWait).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- apps/server-agent/src/services/dispatch-subagent.service.spec.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 service**

`apps/server-agent/src/services/dispatch-subagent.service.ts`:
```ts
import {
  DISPATCH_SUBAGENT_PORT,
  type DispatchSubagentPort,
  AccountContextService,
} from "@meshbot/agent";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { RunnerService } from "./runner.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

/** 账号级并发上限（前台 fan-out 合计）。 */
const SUBAGENT_MAX_CONCURRENCY = 4;

/** 极简账号级信号量：超上限的 acquire 排队等待。 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.queue.push(r));
    this.active++;
  }
  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/**
 * DISPATCH_SUBAGENT_PORT 实现：把子任务委派给隔离子会话跑到完成（前台）。
 * 复用 RunnerService.kickAndWait 跑子会话（子会话 kind=subagent → GraphRunner 自动用子图）。
 */
@Injectable()
export class DispatchSubagentService implements DispatchSubagentPort {
  private readonly logger = new Logger(DispatchSubagentService.name);
  /** 按账号的并发信号量。 */
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(
    private readonly sessions: SessionService,
    private readonly messages: SessionMessageService,
    private readonly runner: RunnerService,
    private readonly emitter: EventEmitter2,
    private readonly account: AccountContextService,
  ) {}

  private semaphore(): Semaphore {
    const acct = this.account.getOrThrow();
    let s = this.semaphores.get(acct);
    if (!s) {
      s = new Semaphore(SUBAGENT_MAX_CONCURRENCY);
      this.semaphores.set(acct, s);
    }
    return s;
  }

  async dispatch(
    params: {
      parentSessionId: string;
      parentToolCallId: string;
      task: string;
      description?: string;
      model?: string;
      background?: boolean;
    },
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) {
      return JSON.stringify({ subSessionId: "", status: "aborted", output: "" });
    }
    // 一层：父会话本身是 subagent 时拒绝派发。
    const parent = await this.sessions.findOrNull(params.parentSessionId);
    if (parent?.kind === "subagent") {
      return JSON.stringify({
        subSessionId: "",
        status: "error",
        output: "子 Agent 不能再派子 Agent（仅支持一层）。",
      });
    }

    const sem = this.semaphore();
    await sem.acquire();
    let subSessionId = "";
    try {
      const created = await this.sessions.createSubSession({
        parentSessionId: params.parentSessionId,
        parentToolCallId: params.parentToolCallId,
        task: params.task,
        description: params.description,
      });
      subSessionId = created.subSessionId;
      // 建好子会话即在父房间发关联事件，前端把父消息里那张 dispatch 卡认领到子会话。
      this.emitter.emit(SESSION_WS_EVENTS.runSubagentSpawned, {
        sessionId: params.parentSessionId,
        toolCallId: params.parentToolCallId,
        subSessionId,
        description: params.description ?? params.task.slice(0, 30),
      });
      // 父 run stop（signal abort）→ 中断子 run（前台随父）。
      const onAbort = () => this.runner.interrupt(subSessionId);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await this.runner.kickAndWait(subSessionId);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      if (signal.aborted) {
        return JSON.stringify({ subSessionId, status: "aborted", output: "" });
      }
      const last = await this.messages.findLastAssistant(subSessionId);
      return JSON.stringify({
        subSessionId,
        status: "done",
        output: last?.content ?? "",
      });
    } catch (err) {
      this.logger.warn(
        `dispatch 子 Agent 失败 sub=${subSessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return JSON.stringify({
        subSessionId,
        status: "error",
        output: err instanceof Error ? err.message : String(err),
      });
    } finally {
      sem.release();
    }
  }
}
```

- [ ] **Step 4: 写 module**

`apps/server-agent/src/dispatch-subagent.module.ts`:
```ts
import { DISPATCH_SUBAGENT_PORT } from "@meshbot/agent";
import { Global, Module } from "@nestjs/common";
import { DispatchSubagentService } from "./services/dispatch-subagent.service";

/**
 * @Global 绑定 DISPATCH_SUBAGENT_PORT → DispatchSubagentService。
 * 依赖 SessionService/SessionMessageService/RunnerService（由各自模块 export，
 * 或本模块 imports 对应模块）——按 app.module 现有装配把所需 provider 引到本模块可见。
 */
@Global()
@Module({
  providers: [
    DispatchSubagentService,
    { provide: DISPATCH_SUBAGENT_PORT, useExisting: DispatchSubagentService },
  ],
  exports: [DISPATCH_SUBAGENT_PORT, DispatchSubagentService],
})
export class DispatchSubagentModule {}
```
（注意 DI 可见性：`DispatchSubagentService` 注入 `RunnerService`/`SessionService`/`SessionMessageService`。若它们不在全局可见范围，需在本模块 `imports` 对应模块，或确保其所属模块 `exports` 了这些 provider。装配以 app.module 现状为准，Task 8 boot 会暴露缺失的 provider。）

- [ ] **Step 5: gateway 转发 spawned 事件**

`apps/server-agent/src/ws/session.gateway.ts` 加一个 `@OnEvent`（与现有 `onRunChunk` 等同款，转发到 `payload.sessionId` 房间）：
```ts
  @OnEvent(SESSION_WS_EVENTS.runSubagentSpawned)
  onSubagentSpawned(payload: RunSubagentSpawnedEvent): void {
    this.server.to(payload.sessionId).emit(
      SESSION_WS_EVENTS.runSubagentSpawned,
      payload,
    );
  }
```
（import `RunSubagentSpawnedEvent` from `@meshbot/types-agent`。）

- [ ] **Step 6: app.module 导入**

`apps/server-agent/src/app.module.ts` 的 imports 里加入 `DispatchSubagentModule`。

- [ ] **Step 7: 运行确认通过 + typecheck**

Run: `pnpm test -- apps/server-agent/src/services/dispatch-subagent.service.spec.ts`
Expected: PASS（3 例）。
Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 无错误。

- [ ] **Step 8: 提交**

```bash
git add apps/server-agent/src/services/dispatch-subagent.service.ts apps/server-agent/src/services/dispatch-subagent.service.spec.ts apps/server-agent/src/dispatch-subagent.module.ts apps/server-agent/src/ws/session.gateway.ts apps/server-agent/src/app.module.ts
git commit -m "feat(server-agent): DispatchSubagentService 前台派子 Agent（建子会话→跑到完成→回传）+ 一层守卫 + 并发上限 + spawned 转发

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 集成验证（boot + 全量围栏）

- [ ] **Step 1: 全量 typecheck**

Run: `pnpm typecheck`
Expected: 全绿（对照基线，无新增失败）。

- [ ] **Step 2: 相关测试**

Run: `pnpm test -- apps/server-agent/src/services/dispatch-subagent.service.spec.ts apps/server-agent/src/services/session.service.spec.ts libs/types-agent/src/dispatch-subagent.spec.ts`
以及 libs/agent：`pnpm --filter @meshbot/agent test -- tools.node.spec.ts dispatch-subagent.tool.spec.ts graph.builder.spec.ts`
Expected: 全绿；libs/agent 对照基线（9 个预存在失败 + dist stale 噪音）无新增。

- [ ] **Step 3: BOOT 验证（DI 装配 + 迁移 + 端到端一次派发）**

改了 DI 装配（新 @Global module + RunnerService 注入链）与迁移，必须真启。用隔离 MESHBOT_HOME：
```bash
pnpm --filter @meshbot/server-agent build
TMPHOME="$(mktemp -d)"
( MESHBOT_HOME="$TMPHOME" node apps/server-agent/dist/main.js & SAPID=$! ; sleep 8 ; \
  curl -s http://127.0.0.1:3100/api/health ; echo ; \
  kill "$SAPID" 2>/dev/null )
rm -rf "$TMPHOME"
```
Expected：启动无 DI 报错（无 UnknownDependencies/Nest can't resolve）、迁移 `AddSessionParentLinkage` 跑过、`/api/health` 200。
（注：本分支从 main 切出，不含 PR #7 的端口自检，server-agent 仍监听 3100；stdout 会打 `Agent running on http://0.0.0.0:3100`。若本分支在 PR #7 合并后 rebase，改用 7727。）读**完整 stdout**确认无 `dispatch_subagent` 注册失败 / 无 DISPATCH_SUBAGENT_PORT 解析失败。
（真正「主 Agent 调 dispatch → 子会话跑完回结果」的端到端需配好模型 + 发消息，留人工冒烟；本步先确保装配/迁移/健康。）

- [ ] **Step 4: 静态围栏 + Biome**

Run: `pnpm check && pnpm format && pnpm lint`
Expected: 围栏全绿（本改动无 Entity 归属冲突——Session 仍归 SessionService；无新事务倒置）；Biome 无残留。
> 注意：`check:repo` 会校验 Entity 归属。`DispatchSubagentService` **不得** `@InjectRepository`（它经 SessionService/SessionMessageService 访问）——已如此设计，确认围栏过。

- [ ] **Step 5: 收尾提交（如有格式化改动）**

```bash
git add -A
git commit -m "chore: 派子 Agent Phase 1a 收尾（格式化 + 围栏）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review（计划自审）

- **Spec 覆盖（Phase 1a 范围）**：① 数据模型（Session parent 关联 + subagent kind）→ T2；② schema+port+tool → T1/T6；③ 子图去 dispatch（一层）→ T3 + T7 守卫；④ tools 节点并发 fan-out → T4；⑤ 子会话按 kind 选子图 → T5；⑥ 前台 runToCompletion（建子会话→kickAndWait→读末条）→ T7；⑦ spawned 关联事件（供 1b 前端）→ T1/T7。**明确不在 1a**：`model` 选择、`background` 后台、前端嵌套卡（1b）——schema 已含 model/background 但 T1/T6 注明不生效。
- **占位符扫描**：无 TBD/TODO；每步含可粘贴代码 + 确切命令 + 预期。少数「以文件实际为准」的注记（作用域仓库字段名、DI 装配、迁移注册方式、session.ts 事件对象具体形态）是**必要的现场核对点**而非占位符——因这些依赖现有文件的确切结构，实施者需按现状对齐。
- **类型一致性**：`dispatchSubagentSchema`/`DispatchSubagentInput`（T1）→ port 参数（T6）→ service 参数（T7）字段一致（task/description/model/background）；`DISPATCH_SUBAGENT_PORT` T6 定义、T7 绑定；`runSubagentSpawned`/`RunSubagentSpawnedEvent`（T1）→ service emit（T7）→ gateway 转发（T7）三处一致；`createSubSession`/`findLastAssistant`（T2）→ service 消费（T7）签名一致；`subAgent` 标志 GraphRunner（T5）↔ RunnerService（T5）一致。
- **范围**：Phase 1a 单一后端增量，产出可端到端（boot + 测试）验证的前台子 Agent；前端嵌套卡（1b）、model/background（Phase 2）明确排除。

## 待 1b / Phase 2

- **1b（前端嵌套卡）**：`tool-call-block` 特判 `dispatch_subagent` → 消费 `run.subagent_spawned` 拿 subSessionId → 嵌套内复用 `useSessionStream(subSessionId)` 实时渲染 + 刷新按子会话历史还原。
- **Phase 2**：`background` 后台运行 + 完成自动播报回灌（注入父会话 + kick）+ 独立 abort；`model` 选择（per-run 模型覆盖，需 GraphRunner/ModelResolver 接一条「按指定 ModelConfig 建 provider」的路径）。
