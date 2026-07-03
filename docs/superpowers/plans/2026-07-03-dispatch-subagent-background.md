# 派子 Agent Phase 2（后台派发 + model 覆盖 + 重启恢复）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `dispatch_subagent` 的 `background`/`model` 字段生效：后台派发立即返回、子完成自动播报回灌父会话、嵌套卡可停止子 run、子 run 可指定模型；进程重启后后台任务续跑、丢失播报补发。

**Architecture:** 后台分支 fire-and-forget `settleBackground`（kickAndWait → 终态判定表 → appendMessage+kick 播报 → 重写父 tool 行 → `run.subagent_settled` 事件 → `background=0` → 释放槽）；重启恢复扫描 `background=1` 复用同一 settle。model 覆盖 = Session 持久化 `model_config_id` + `ModelRunContext`（ALS）包裹消费循环 + `ModelResolver` 优先按覆盖 id 解析（顺路把 usage meta 从共享字段改为 run 级上下文）。前端增量：停止按钮（`sub.interrupt()` 现成）+ settled 消费。

**Tech Stack:** NestJS + LangGraph（libs/agent）、TypeORM/SQLite 迁移、AsyncLocalStorage、Jest（server-agent/types-agent/web-agent 纯函数）、Vitest（libs/agent）。

**设计 spec:** `docs/superpowers/specs/2026-07-03-dispatch-subagent-background-design.md`

## Global Constraints

- 分支 `feat/dispatch-subagent-background`（已存在，自 main 6aa62cb 切出，spec 已提交）。不 push、不开 PR（收尾由控制者处理）。
- 终态判定表（spec §4，已按 runner 实况核实——interrupt 后被中断消息停留在 processing，不 markFailed 不回滚）：有 failed pending → `error`；有非 failed 活跃 pending（中断遗留）→ `aborted`；无活跃 pending → `done`（`findLastAssistant` 为 null 记 `error`，output=「子 Agent 未产生任何回复。」）。**前台与后台共用**这张表。
- 后台返回 JSON `{subSessionId, status:"running"}`；后台占信号量槽至 settle 结束（前台+后台合计上限 `SUBAGENT_MAX_CONCURRENCY=4` 不变）；后台**不挂父 signal**。
- 播报照 schedule-executor 先例：`sessions.appendMessage(父, {messageId: randomUUID(), content})` + `runner.kick(父)`；文本 `子任务「<description>」已完成/失败/已中止。` + output 非空时换行接 `结果：\n<capForLlm(output)>`。
- `background` 列语义=「有待了结的后台子任务」，播报完成（或父会话已删）置 0；播报 appendMessage 失败重试一次，仍失败**保持 background=1**（重启补发）并记日志。
- model 覆盖：dispatch 按 **id 优先、name 次之** 查 ModelConfig（含未启用），查不到返回 `{subSessionId:"", status:"error", output:"未找到模型配置「<model>」，请检查 model 参数（可用模型名见设置）。"}`；解析成功把 **id** 写入子会话 `model_config_id`。
- **ALS 位置铁律**：async generator 的 `next()` 运行在调用方上下文——`ModelRunContext` 必须包裹 `consumeRunStream` 的「建流 + for-await 消费」整段，包在 generator 创建处无效。
- libs/agent 纪律：只 `@Injectable`+生命周期，禁 TypeORM/HTTP/@InjectRepository；测试 vitest。web-agent 纯逻辑模块零 import（根 jest node 环境，jotai 纯 ESM 会炸）。
- i18n zh/en 键对称（pre-commit 强制）；公开方法中文 JSDoc；Biome `if` 前一行不放注释；事务方法命名约定（`*InTx`/`persist*`）；单表读写不挂 `@Transactional`。
- 中文 conventional commits + 结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。**只跑本任务相关测试**，全量/boot/冒烟留 Task 8。
- 基线：根 jest 全绿+1 skip；libs/agent vitest 9 个预存在失败（graph-runner.test.ts 内 3 个 + 其他），只看新增。dev 库在仓库根 `.meshbot/`，勿动；server-agent 端口自检（看启动日志/agent.port）。

---

## File Structure

**新建：**
- `apps/server-agent/src/migrations/1780800000000-AddSessionBackgroundAndModel.ts`
- `libs/agent/src/graph/model-run-context.ts`（ALS：覆盖 id + run 级 meta）
- `libs/agent/tests/unit/model-run-context.test.ts`、`libs/agent/tests/unit/model-resolver-override.test.ts`
- `libs/types-agent/src/subagent-settled.spec.ts`

**修改：**
- `libs/types-agent/src/session.ts` — `RunSubagentSettledEvent` + 事件常量。
- `apps/server-agent/src/entities/session.entity.ts` — `background`、`modelConfigId` 字段。
- `apps/server-agent/src/services/session.service.ts` — `createSubSession` 扩展、`setBackground`、`listPendingBackgroundSubagentsUnscoped`。
- `apps/server-agent/src/services/session-message.service.ts` — `updateToolResult`。
- `apps/server-agent/src/services/model-config.service.ts` — `findByIdOrName`。
- `libs/agent/src/config/model-config.reader.ts` — `readModelConfigById`。
- `libs/agent/src/graph/model-resolver.service.ts` — 覆盖解析 + meta 入上下文。
- `libs/agent/src/graph/nodes/tools.node.ts` — `capForLlm` 导出。
- `libs/agent/src/agent.module.ts`、`libs/agent/src/index.ts` — `ModelRunContext` 注册/导出、`capForLlm` 导出。
- `apps/server-agent/src/services/runner.service.ts` — 消费循环包 `ModelRunContext`。
- `apps/server-agent/src/services/runner.service.spec.ts` — 装配补 `ModelRunContext`（吸取 1b 漏装配教训）。
- `apps/server-agent/src/services/dispatch-subagent.service.ts`（+spec）— 后台分支/终态表/settle/model 解析/boot 恢复。
- `apps/server-agent/src/ws/session.gateway.ts` — settled 转发。
- `apps/web-agent/src/lib/subagent-card.ts`（+spec）— running 分支 + settled 打标。
- `apps/web-agent/src/hooks/use-session-stream.ts` — settled 消费。
- `apps/web-agent/src/components/session/subagent-card.tsx` — 停止按钮。
- `apps/web-agent/messages/zh.json` / `en.json` — `session.subagent.stop`。

---

## Task 1: types-agent — RunSubagentSettledEvent + 事件常量

**Files:**
- Modify: `libs/types-agent/src/session.ts`（`RunSubagentSpawnedEvent` 之后、`SESSION_WS_EVENTS` 常量表）
- Create: `libs/types-agent/src/subagent-settled.spec.ts`

**Interfaces:**
- Produces: `RunSubagentSettledEvent { sessionId; toolCallId; subSessionId; status:"done"|"error"|"aborted"; output:string }`；`SESSION_WS_EVENTS.runSubagentSettled === "run.subagent_settled"`。Task 5 emit/转发、Task 7 前端消费。

- [ ] **Step 1: 写失败测试**

新建 `libs/types-agent/src/subagent-settled.spec.ts`：

```ts
import type { RunSubagentSettledEvent } from "./session";
import { SESSION_WS_EVENTS } from "./session";

describe("RunSubagentSettledEvent", () => {
  it("事件常量为 run.subagent_settled", () => {
    expect(SESSION_WS_EVENTS.runSubagentSettled).toBe("run.subagent_settled");
  });

  it("payload 形状编译期成立（status 三态）", () => {
    const e: RunSubagentSettledEvent = {
      sessionId: "p1",
      toolCallId: "tc1",
      subSessionId: "s1",
      status: "aborted",
      output: "",
    };
    expect(e.status).toBe("aborted");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest libs/types-agent/src/subagent-settled.spec.ts`
Expected: FAIL——`runSubagentSettled` 不存在（TS 编译错 / undefined）。

- [ ] **Step 3: 实现**

`session.ts` 中 `RunSubagentSpawnedEvent` 接口之后加：

```ts
/** 子 Agent 了结事件：后台子任务终态回传，前端把 dispatch 卡更新为终态。 */
export interface RunSubagentSettledEvent {
  /** 父会话 id（事件按此路由到父房间）。 */
  sessionId: string;
  /** 父会话里那次 dispatch 工具调用的 toolCallId。 */
  toolCallId: string;
  /** 子会话 id。 */
  subSessionId: string;
  /** 子 run 终态。 */
  status: "done" | "error" | "aborted";
  /** 终态输出（已截断），与重写后的工具结果 JSON 一致。 */
  output: string;
}
```

`SESSION_WS_EVENTS` 的 `runSubagentSpawned` 行后加：

```ts
  runSubagentSettled: "run.subagent_settled",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm jest libs/types-agent/src/subagent-settled.spec.ts`
Expected: 2/2 PASS。

- [ ] **Step 5: 提交**

```bash
git add libs/types-agent/src/session.ts libs/types-agent/src/subagent-settled.spec.ts
git commit -m "feat(types-agent): run.subagent_settled 事件类型（后台子任务终态回传）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: server-agent 数据层 — 两列迁移 + Session/消息服务方法

**Files:**
- Create: `apps/server-agent/src/migrations/1780800000000-AddSessionBackgroundAndModel.ts`
- Modify: `apps/server-agent/src/entities/session.entity.ts`、`apps/server-agent/src/services/session.service.ts`、`apps/server-agent/src/services/session-message.service.ts`
- Test: `apps/server-agent/src/services/session.service.spec.ts`、`apps/server-agent/src/services/session-message.service.spec.ts`（若无该 spec 文件则在 session.service.spec.ts 同款真库装配下新建）

**Interfaces:**
- Consumes: 既有 `createSubSession`/`createSubSessionInTx`（1a）。
- Produces（Task 5/6 消费）：
  - `createSubSession(input: { parentSessionId; parentToolCallId; task; description?; background?: boolean; modelConfigId?: string | null }) → { subSessionId }`
  - `SessionService.setBackground(sessionId: string, value: boolean): Promise<void>`
  - `SessionService.listPendingBackgroundSubagentsUnscoped(): Promise<Array<Pick<Session, "id" | "parentSessionId" | "parentToolCallId" | "title" | "cloudUserId">>>`
  - `SessionMessageService.updateToolResult(toolCallId: string, content: string): Promise<number>`（返回受影响行数）

- [ ] **Step 1: 迁移 + Entity（无独立测试，靠真库 synchronize 的 service 测试与 Task 8 boot 验证）**

新建迁移（照 `1780700000000-AddSessionParentLinkage.ts` 的结构与注释风格）：

```ts
import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase 2：后台派发支持。
 * - background：「有待了结的后台子任务」标记（建后台子会话置 1，播报完成置 0），
 *   兼作重启恢复扫描键。
 * - model_config_id：per-run 模型覆盖（dispatch 解析成功的 ModelConfig id）。
 * SQLite 限制：down 不删列（与既有迁移约定一致）。
 */
export class AddSessionBackgroundAndModel1780800000000
  implements MigrationInterface
{
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "sessions" ADD COLUMN "background" integer NOT NULL DEFAULT 0`,
    );
    await q.query(`ALTER TABLE "sessions" ADD COLUMN "model_config_id" TEXT`);
  }

  async down(): Promise<void> {
    // SQLite 不支持 DROP COLUMN（旧版），保持列存在（幂等，与仓库既有迁移一致）
  }
}
```

`session.entity.ts` 在 `parentToolCallId` 字段后加：

```ts
  /** 「有待了结的后台子任务」标记：建后台子会话置 1，播报完成置 0；兼作重启恢复扫描键。 */
  @Column({ type: "integer", default: 0 })
  background!: number;

  /** per-run 模型覆盖：dispatch 解析成功的 ModelConfig id；非 subagent 会话恒 NULL。 */
  @Column({ name: "model_config_id", type: "text", nullable: true })
  modelConfigId!: string | null;
```

- [ ] **Step 2: 写失败测试（service 方法）**

`session.service.spec.ts` 的 `describe("createSubSession")` 内追加（沿用真库装配与账号上下文代理 `service`）：

```ts
it("createSubSession 可写 background 与 modelConfigId；setBackground 可置回 0", async () => {
  const { subSessionId } = await service.createSubSession({
    parentSessionId: "990000000000000010",
    parentToolCallId: "tc-bg",
    task: "后台任务",
    background: true,
    modelConfigId: "mc-1",
  });
  const row = await service.findOrNull(subSessionId);
  expect(row?.background).toBe(1);
  expect(row?.modelConfigId).toBe("mc-1");
  await service.setBackground(subSessionId, false);
  expect((await service.findOrNull(subSessionId))?.background).toBe(0);
});

it("缺省 background=0、modelConfigId=null（前台不受影响）", async () => {
  const { subSessionId } = await service.createSubSession({
    parentSessionId: "990000000000000010",
    parentToolCallId: "tc-fg",
    task: "前台任务",
  });
  const row = await service.findOrNull(subSessionId);
  expect(row?.background).toBe(0);
  expect(row?.modelConfigId).toBeNull();
});

it("listPendingBackgroundSubagentsUnscoped 只返回 background=1 的 subagent 会话（跨账号）", async () => {
  const a = await service.createSubSession({
    parentSessionId: "990000000000000010",
    parentToolCallId: "tc-1",
    task: "A",
    background: true,
  });
  await service.createSubSession({
    parentSessionId: "990000000000000010",
    parentToolCallId: "tc-2",
    task: "B",
  });
  const rows = await rawService.listPendingBackgroundSubagentsUnscoped();
  expect(rows.map((r) => r.id)).toContain(a.subSessionId);
  expect(rows.every((r) => r.parentSessionId && r.cloudUserId)).toBe(true);
  expect(
    rows.find((r) => r.parentToolCallId === "tc-2"),
  ).toBeUndefined();
});
```

updateToolResult 测试（session-message.service 的测试位置以现状为准；若该服务无独立 spec，加在 session.service.spec.ts 里用其真库装配直接调 `sessionMessages`——装配处已实例化）：

```ts
it("updateToolResult 按 toolCallId 重写 tool 行 content，返回受影响行数", async () => {
  const sid = "990000000000000020";
  await messages.recordToolResult({
    sessionId: sid,
    toolCallId: "tc-x",
    content: '{"status":"running"}',
    ok: true,
  });
  const n = await messages.updateToolResult("tc-x", '{"status":"done","output":"ok"}');
  expect(n).toBe(1);
  expect(await messages.updateToolResult("tc-404", "{}")).toBe(0);
});
```

（`recordToolResult` 的入参以文件实际为准，测试造数按实际签名调整。）

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm jest apps/server-agent/src/services/session.service.spec.ts -t "background"`
Expected: FAIL（createSubSession 不接收新字段 / setBackground 不存在）。

- [ ] **Step 4: 实现**

`session.service.ts`：`createSubSession`/`createSubSessionInTx` 入参加 `background?: boolean; modelConfigId?: string | null`，InTx 写入行时加 `background: input.background ? 1 : 0, modelConfigId: input.modelConfigId ?? null`（具体插入语句以现状为准，最小增量）。新增：

```ts
/** 置/清「待了结后台子任务」标记（播报完成置 0）。 */
async setBackground(sessionId: string, value: boolean): Promise<void> {
  await this.sessionRepo.update({ id: sessionId }, { background: value ? 1 : 0 });
}

/**
 * 系统级扫描：所有账号的「待了结后台子任务」（kind=subagent 且 background=1）。
 * 仅供进程启动恢复用——boot 时无账号上下文，须 unscoped 反查后逐个建上下文处理。
 */
listPendingBackgroundSubagentsUnscoped(): Promise<
  Array<Pick<Session, "id" | "parentSessionId" | "parentToolCallId" | "title" | "cloudUserId">>
> {
  // scope-check: allow-unscoped
  return this.sessionRepo.unscoped().find({
    where: { kind: "subagent", background: 1 },
    select: {
      id: true,
      parentSessionId: true,
      parentToolCallId: true,
      title: true,
      cloudUserId: true,
    },
  });
}
```

`session-message.service.ts` 新增：

```ts
/**
 * 按 toolCallId 重写 tool 行结果（后台子任务终态回写 UI 副本；不动 checkpointer，
 * 父 LLM 上下文不受影响）。返回受影响行数——0 表示 tool 行尚未落库（调用方可重试）。
 */
async updateToolResult(toolCallId: string, content: string): Promise<number> {
  const r = await this.repo.update({ toolCallId, role: "tool" }, { content });
  return r.affected ?? 0;
}
```

（repo 字段名以该文件现状为准——若作用域仓库变量名不同按实际。）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm jest apps/server-agent/src/services/session.service.spec.ts apps/server-agent/src/services/session-message.service.spec.ts 2>/dev/null || pnpm jest apps/server-agent/src/services/session.service.spec.ts`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add apps/server-agent/src/migrations/1780800000000-AddSessionBackgroundAndModel.ts \
        apps/server-agent/src/entities/session.entity.ts \
        apps/server-agent/src/services/session.service.ts \
        apps/server-agent/src/services/session-message.service.ts \
        apps/server-agent/src/services/*.spec.ts
git commit -m "feat(server-agent): Session 加 background/model_config_id 列 + 后台派发数据层方法

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: libs/agent — ModelRunContext + 覆盖解析 + usage meta 修复 + capForLlm 导出

**Files:**
- Create: `libs/agent/src/graph/model-run-context.ts`、`libs/agent/tests/unit/model-run-context.test.ts`、`libs/agent/tests/unit/model-resolver-override.test.ts`
- Modify: `libs/agent/src/config/model-config.reader.ts`、`libs/agent/src/graph/model-resolver.service.ts`、`libs/agent/src/graph/nodes/tools.node.ts`（仅 export）、`libs/agent/src/agent.module.ts`、`libs/agent/src/index.ts`

**Interfaces:**
- Produces（Task 4/5 消费）：
  - `ModelRunContext.run<T>(modelConfigId: string | null, fn: () => T): T`（**无论有无覆盖都建 store**——store 同时承载本 run 的 meta）；`getOverrideId(): string | null`；`setMeta(meta)`/`getMeta(): {providerType; model} | null`。
  - `readModelConfigById(dbPath, cloudUserId, id): ActiveModelConfig | null`（按 id，**不过滤 enabled**）。
  - `capForLlm(content: string): string`（现有实现原样导出）。
  - `ModelResolver.getMeta()` 语义升级：优先返回本 run 上下文 meta，无上下文回落共享字段（兼容既有 title 路径/测试）。

- [ ] **Step 1: 写失败测试**

`libs/agent/tests/unit/model-run-context.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { ModelRunContext } from "../../src/graph/model-run-context";

describe("ModelRunContext", () => {
  it("run 内可读覆盖 id，run 外为 null", async () => {
    const ctx = new ModelRunContext();
    expect(ctx.getOverrideId()).toBeNull();
    await ctx.run("mc-1", async () => {
      expect(ctx.getOverrideId()).toBe("mc-1");
      await Promise.resolve();
      expect(ctx.getOverrideId()).toBe("mc-1");
    });
    expect(ctx.getOverrideId()).toBeNull();
  });

  it("无覆盖也建 store：meta 可写读且并行 run 互不串", async () => {
    const ctx = new ModelRunContext();
    const read = (tag: string) =>
      ctx.run(null, async () => {
        ctx.setMeta({ providerType: tag, model: tag });
        await new Promise((r) => setTimeout(r, 5));
        return ctx.getMeta()?.model;
      });
    const [a, b] = await Promise.all([read("A"), read("B")]);
    expect(a).toBe("A");
    expect(b).toBe("B");
  });
});
```

`libs/agent/tests/unit/model-resolver-override.test.ts`（读现有 model-resolver 相关测试的桩风格；resolveModel 读真 SQLite——用临时 better-sqlite3 文件建 `model_configs` 表造数，参考 `model-config.reader` 的列名）：

```ts
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountContextService } from "../../src/account/account-context.service";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { ModelRunContext } from "../../src/graph/model-run-context";
import { ModelResolver } from "../../src/graph/model-resolver.service";

describe("ModelResolver 覆盖解析", () => {
  let dir: string;
  let dbPath: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mrc-"));
    dbPath = join(dir, "agent.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE model_configs (
      id TEXT PRIMARY KEY, cloud_user_id TEXT, provider_type TEXT, name TEXT,
      model TEXT, api_key TEXT, base_url TEXT DEFAULT '', enabled INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.prepare(
      `INSERT INTO model_configs (id, cloud_user_id, provider_type, name, model, api_key, enabled)
       VALUES ('mc-default','u1','openai','默认','gpt-a','k',1),
              ('mc-alt','u1','deepseek','备用','ds-b','k',0)`,
    ).run();
    db.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function make() {
    const account = new AccountContextService();
    const config = { getDatabasePath: () => dbPath } as unknown as MeshbotConfigService;
    const runCtx = new ModelRunContext();
    const resolver = new ModelResolver(config, account, runCtx);
    return { account, runCtx, resolver };
  }

  it("无覆盖解析 enabled 配置；meta 写进 run 上下文", async () => {
    const { account, runCtx, resolver } = make();
    await account.run("u1", () =>
      runCtx.run(null, async () => {
        await resolver.resolveModel();
        expect(resolver.getMeta()).toEqual({ providerType: "openai", model: "gpt-a" });
      }),
    );
  });

  it("覆盖 id 优先且可用未启用配置", async () => {
    const { account, runCtx, resolver } = make();
    await account.run("u1", () =>
      runCtx.run("mc-alt", async () => {
        await resolver.resolveModel();
        expect(resolver.getMeta()).toEqual({ providerType: "deepseek", model: "ds-b" });
      }),
    );
  });

  it("覆盖 id 不存在 → 抛错（含 id）", async () => {
    const { account, runCtx, resolver } = make();
    await expect(
      account.run("u1", () =>
        runCtx.run("mc-404", () => resolver.resolveModel()),
      ),
    ).rejects.toThrow(/mc-404/);
  });
});
```

（`ModelResolver` 构造参数含 `@Optional` 注入——新加 `ModelRunContext` 参数的位置以实现为准，测试相应传参；`createChatModel` 会真的构造 provider 实例，若其构造需要网络/校验导致测试不稳，用 `resolver` 的 override 桩绕过 model 构造、只断言 meta 与错误路径——**meta 与错误路径是本测试的核心**。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd libs/agent && npx vitest run tests/unit/model-run-context.test.ts tests/unit/model-resolver-override.test.ts`
Expected: FAIL（模块不存在 / 构造签名不符）。

- [ ] **Step 3: 实现**

`libs/agent/src/graph/model-run-context.ts`：

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";

interface ModelRunStore {
  /** per-run 模型覆盖：ModelConfig id；null=用当前启用配置。 */
  modelConfigId: string | null;
  /** 本 run 最近一次解析出的模型 meta（usage 标注用，run 间互不串）。 */
  meta: { providerType: string; model: string } | null;
}

/**
 * run 级模型上下文（AsyncLocalStorage）：承载 per-run 模型覆盖 id 与本 run 已
 * 解析的 meta。RunnerService 在消费循环外层 run()（无论有无覆盖都建 store，
 * meta 才能按 run 隔离——共享实例字段在并行 run 用不同模型时会互相覆盖标错
 * llm_calls）。注意 async generator 的 next() 跑在调用方上下文：必须包裹
 * 「建流 + for-await」整段，包在 generator 创建处无效。
 */
@Injectable()
export class ModelRunContext {
  private readonly als = new AsyncLocalStorage<ModelRunStore>();

  /** 在 run 级模型上下文中执行 fn（总是新建 store）。 */
  run<T>(modelConfigId: string | null, fn: () => T): T {
    return this.als.run({ modelConfigId, meta: null }, fn);
  }

  /** 当前 run 的覆盖 id；无上下文或无覆盖返回 null。 */
  getOverrideId(): string | null {
    return this.als.getStore()?.modelConfigId ?? null;
  }

  /** 写入本 run 解析出的模型 meta。 */
  setMeta(meta: { providerType: string; model: string }): void {
    const store = this.als.getStore();
    if (store) store.meta = meta;
  }

  /** 本 run 的模型 meta；无上下文返回 null。 */
  getMeta(): { providerType: string; model: string } | null {
    return this.als.getStore()?.meta ?? null;
  }
}
```

`model-config.reader.ts` 加（列名/风格照 `readActiveModelConfig`）：

```ts
/**
 * 按 id 读指定账号的模型凭证（per-run 覆盖用；**不过滤 enabled**——覆盖本意
 * 就是用非默认模型）。查不到返回 null。
 */
export function readModelConfigById(
  dbPath: string,
  cloudUserId: string,
  id: string,
): ActiveModelConfig | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT provider_type, model, api_key, base_url
         FROM model_configs WHERE cloud_user_id = ? AND id = ? LIMIT 1`,
      )
      .get(cloudUserId, id) as
      | { provider_type: string; model: string; api_key: string; base_url: string }
      | undefined;
    if (!row) return null;
    return {
      providerType: row.provider_type,
      model: row.model,
      apiKey: row.api_key,
      baseUrl: row.base_url,
    };
  } finally {
    db.close();
  }
}
```

`model-resolver.service.ts`：构造注入 `private readonly runCtx: ModelRunContext`（放在 `@Optional` 参数之前，避免 Optional 参数错位；所有 new ModelResolver 的既有测试装配同步补参——**这是漏装配高危点，grep `new ModelResolver(` 全部对齐**）。`resolveModel` 改：

```ts
async resolveModel(): Promise<BaseChatModel> {
  const dbPath = this.config.getDatabasePath();
  const acct = this.account.getOrThrow();
  const overrideId = this.runCtx.getOverrideId();
  const cfg = overrideId
    ? readModelConfigById(dbPath, acct, overrideId)
    : readActiveModelConfig(dbPath, acct);
  if (!cfg) {
    throw new Error(
      overrideId
        ? `指定的模型配置不存在：${overrideId}（可能已被删除）`
        : "当前账号没有启用的模型配置，请先在设置中配置模型",
    );
  }
  const meta = { providerType: cfg.providerType, model: cfg.model };
  this.modelMeta = meta;
  this.runCtx.setMeta(meta);
  const key = `${cfg.providerType}|${cfg.model}|${cfg.baseUrl ?? ""}|${cfg.apiKey ?? ""}`;
  const cached = this.modelCache.get(key);
  if (cached) return cached;
  const model = await createChatModel(cfg);
  this.modelCache.set(key, model);
  return model;
}
```

`getMeta()` 改为：

```ts
/** 当前 run 的模型 meta（run 上下文优先；无上下文回落共享字段——title 等旁路径）。 */
getMeta(): { providerType: string; model: string } {
  return this.runCtx.getMeta() ?? this.modelMeta;
}
```

`tools.node.ts`：`function capForLlm` 前加 `export`（其余不动）。
`agent.module.ts`：providers/exports 加 `ModelRunContext`。`index.ts`：加 `export { ModelRunContext } from "./graph/model-run-context";` 与 `export { capForLlm } from "./graph/nodes/tools.node";`。

- [ ] **Step 4: 跑测试确认通过 + 既有装配对齐**

Run: `cd libs/agent && npx vitest run tests/unit/model-run-context.test.ts tests/unit/model-resolver-override.test.ts && npx vitest run tests/unit/ 2>&1 | tail -3`
Expected: 新测试全绿；unit 整目录失败数不高于基线（改构造签名后 `new ModelResolver(` 的既有装配已全部补参）。

- [ ] **Step 5: 提交**

```bash
git add libs/agent/src apps 2>/dev/null; git add libs/agent
git commit -m "feat(agent): ModelRunContext（per-run 模型覆盖 + run 级 usage meta）+ readModelConfigById + capForLlm 导出

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: RunnerService — 消费循环包 ModelRunContext

**Files:**
- Modify: `apps/server-agent/src/services/runner.service.ts`（`consumeRunStream`）
- Test: `apps/server-agent/src/services/runner.service.spec.ts`

**Interfaces:**
- Consumes: Task 3 的 `ModelRunContext`（`@meshbot/agent` 导出）；session 行的 `modelConfigId`（Task 2）。
- Produces: 每个 run 的消费段都运行在 `ModelRunContext.run(session?.modelConfigId ?? null, ...)` 内——Task 3 的 resolveModel/meta 因此生效。

- [ ] **Step 1: 写失败测试**

`runner.service.spec.ts`：装配处（`new RunnerService(...)` 或 provider 数组）**补 `ModelRunContext` 真实例**（零副作用，直接 `new ModelRunContext()`；1b 教训——服务加构造依赖必须同步补所有测试装配）。加用例（沿用该 spec 既有 mock 风格；mock 的 `sessions.findOrNull` 返回带 `modelConfigId: "mc-9"` 的 session）：

```ts
it("consumeRunStream 全程运行在 ModelRunContext 内且带 session 的 modelConfigId", async () => {
  // graphRunner.streamMessage 的 mock 在被迭代时读取 runCtx.getOverrideId()
  const seen: Array<string | null> = [];
  graphRunner.streamMessage.mockImplementation(async function* () {
    seen.push(runCtx.getOverrideId());
    yield { kind: "assistant_done", messageId: "m1", content: "hi", reasoning: "", toolCalls: null };
  });
  sessions.findOrNull.mockResolvedValue({ kind: "subagent", modelConfigId: "mc-9" });
  await service.kickAndWait(SESSION_ID);
  expect(seen).toEqual(["mc-9"]);
});
```

（`SESSION_ID`/mock 变量名/事件对象形态以该 spec 现状为准——它已有多个 kickAndWait 用例可照抄造数；关键断言=generator **迭代时**能读到覆盖 id，这正是 ALS 位置铁律的回归守卫。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest apps/server-agent/src/services/runner.service.spec.ts -t "ModelRunContext"`
Expected: FAIL（`seen` 为 `[null]`——尚未包裹）。

- [ ] **Step 3: 实现**

`runner.service.ts`：构造注入 `private readonly modelRunCtx: ModelRunContext`（import 自 `@meshbot/agent`）。`consumeRunStream` 改结构——读 session 后把「建流 + for-await 消费 + finally」整段搬进包裹（**不得只包建流**）：

```ts
private async consumeRunStream(...): Promise<void> {
  const session = await this.sessions.findOrNull(sessionId);
  const subAgent = session?.kind === "subagent";
  await this.modelRunCtx.run(session?.modelConfigId ?? null, () =>
    this.consumeRunStreamInCtx(sessionId, batch, run, resume, runStartedAt, subAgent),
  );
}

/** consumeRunStream 的原有主体（建流 + 逐事件消费），整体运行在 ModelRunContext 内。 */
private async consumeRunStreamInCtx(..., subAgent: boolean): Promise<void> {
  // ……原有 const stream = resume ? ... 起的全部内容原样搬入，仅去掉 session/subAgent 读取……
}
```

（纯搬移不改逻辑；`firstHumanLogged` 等局部变量随主体走。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm jest apps/server-agent/src/services/runner.service.spec.ts`
Expected: 全绿（19+1 个）。

- [ ] **Step 5: 提交**

```bash
git add apps/server-agent/src/services/runner.service.ts apps/server-agent/src/services/runner.service.spec.ts
git commit -m "feat(server-agent): 消费循环包 ModelRunContext（per-run 模型覆盖生效点）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: DispatchSubagentService — 终态判定表 + 后台分支 + settle 链 + model 解析 + gateway 转发

**Files:**
- Modify: `apps/server-agent/src/services/dispatch-subagent.service.ts`、`apps/server-agent/src/services/model-config.service.ts`、`apps/server-agent/src/ws/session.gateway.ts`
- Test: `apps/server-agent/src/services/dispatch-subagent.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 `RunSubagentSettledEvent`/常量；Task 2 全部数据层方法；Task 3 `capForLlm`。
- Produces: `ModelConfigService.findByIdOrName(idOrName: string): Promise<ModelConfig | null>`；`DispatchSubagentService.settleBackground(args: { subSessionId; parentSessionId; parentToolCallId; description }): Promise<void>`（**public**，Task 6 复用；内部不 acquire 槽——调用方持槽，settle 的 finally 释放）。

**行为规格（测试即按此写）：**
1. **终态判定表**（新私有 `readTerminalState(subSessionId)`）：`listActivePending` 有 failed → `{status:"error", output:"子 Agent 运行失败，未产出结果。"}`；有非 failed 活跃条目 → `{status:"aborted", output:""}`；空 → `findLastAssistant`，null → `{status:"error", output:"子 Agent 未产生任何回复。"}`，否则 `{status:"done", output:last.content}`。**前台分支改用它**（替换现有 hasFailedPending/findLastAssistant 段；父 signal 的两处 aborted 短路保持在前）。
2. **model 解析**（前台/后台共用，建子会话前）：`params.model` 非空 → `modelConfigs.findByIdOrName(params.model)`，null → 直接返回 `{subSessionId:"", status:"error", output:'未找到模型配置「<model>」，请检查 model 参数（可用模型名见设置）。'}`（**在 acquire 之前**，不占槽）；命中把 `.id` 传给 `createSubSession.modelConfigId`。
3. **后台分支**（`params.background === true`）：守卫/解析/acquire/createSubSession（`background: true`）/spawned 事件同前台；不挂父 signal、不等待——`void this.settleBackground({...}).catch(logger)`（settle 的 finally 释放槽，dispatch 本身**不**释放）；立即返回 `{subSessionId, status:"running"}`。入口与排队后的 `signal.aborted` 检查保留（此时释放槽并短路）。
4. **settleBackground**：`kickAndWait(sub)` → `readTerminalState` → 组终局 JSON `{subSessionId, status, output}` → `findOrNull(parent)`：
   - 父在：播报文本 = `子任务「<description>」<已完成|失败|已中止>。` + (output && `\n结果：\n${capForLlm(output)}`)；`sessions.appendMessage(parent, {messageId: randomUUID(), content})`——抛错重试一次，再抛则 log 后 **return（保持 background=1）**；`runner.kick(parent)`；`messages.updateToolResult(parentToolCallId, 终局JSON)`——返回 0 时等 1s 重试一次（tool 行落库竞速），仍 0 记 warn；emit `SESSION_WS_EVENTS.runSubagentSettled`（payload 按 Task 1 类型，output 用 capForLlm 后文本）。
   - 父已删：跳过播报/重写/事件。
   - 最后 `setBackground(sub, false)`；`finally { sem.release() }`（semaphore 通过 `this.semaphore()` 取——settle 运行在 dispatch 的账号 ALS 延续里，boot 路径由 Task 6 显式包 account.run）。
5. **gateway**：`onSubagentSpawned` 后加同款：

```ts
/** 后台子任务终态 → 转发到父会话房间（前端把 dispatch 卡更新为终态）。 */
@OnEvent(SESSION_WS_EVENTS.runSubagentSettled)
onSubagentSettled(payload: RunSubagentSettledEvent): void {
  this.server
    .to(payload.sessionId)
    .emit(SESSION_WS_EVENTS.runSubagentSettled, payload);
}
```

- [ ] **Step 1: 写失败测试（覆盖行为规格 1-4）**

`dispatch-subagent.service.spec.ts` 追加（沿用现有 mock 装配 `make()`；mock 新依赖 `modelConfigs.findByIdOrName`、`sessions.setBackground`、`sessions.listActivePending`、`messages.updateToolResult`、`runner.kick`）。用例清单（每条一个 it，断言按规格逐字）：
- 前台：中断遗留（listActivePending 返回一条 `status:"processing"`）→ 返回 `status:"aborted"`（**新行为**：不依赖父 signal）。
- 前台：failed → error；空 + 无 assistant → error；空 + 有 assistant → done（回归既有语义）。
- model：findByIdOrName null → 立即 error JSON、`createSubSession` 未被调、未 acquire（信号量满时也不阻塞——可断言 `sessions.createSubSession` 未调用即可）。
- model：命中 → `createSubSession` 收到 `modelConfigId: <id>`。
- 后台：立即返回 `{subSessionId, status:"running"}`；`createSubSession` 收到 `background: true`；kickAndWait 尚未 resolve 时 dispatch 已返回（deferred mock）。
- 后台 settle 成功链：kickAndWait resolve 后（flush microtask/await deferred），按序发生 appendMessage（内容含「已完成」与 output）→ kick(parent) → updateToolResult(toolCallId, 终局 JSON) → emit settled → setBackground(sub, false)。
- 后台 settle：父已删（findOrNull null）→ 无 appendMessage/updateToolResult/emit，但 setBackground(false) 仍执行。
- 后台 settle：appendMessage 连抛两次 → 不 kick、不置 0（background 保持）。
- 槽位：后台 settle 完成后释放（第 5 个 dispatch 的 deferred 断言，参照既有信号量测试写法）。

（既有信号量/abort 用例的 mock 需补 `listActivePending: async () => []` 与 `setBackground: async () => {}`——服务新调用，装配同步补，1b 教训。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest apps/server-agent/src/services/dispatch-subagent.service.spec.ts`
Expected: 新用例 FAIL（方法/分支不存在）。

- [ ] **Step 3: 实现（含 findByIdOrName）**

`model-config.service.ts` 新增：

```ts
/** 按 id 优先、name 次之查模型配置（dispatch model 覆盖用；含未启用）。查不到返回 null。 */
async findByIdOrName(idOrName: string): Promise<ModelConfig | null> {
  const byId = await this.repo.findOneBy({ id: idOrName });
  if (byId) return byId;
  return this.repo.findOneBy({ name: idOrName });
}
```

（repo 变量名以该文件现状为准。）`dispatch-subagent.service.ts` 按行为规格实现：dispatch 重构为「守卫 → model 解析 → acquire → aborted 短路 → createSubSession(+background/modelConfigId) → spawned → 前台|后台分支」；构造注入 `ModelConfigService`（`DispatchSubagentModule` imports 对应模块或其已 @Global——**装配以实际为准，若 ModelConfigModule 未导出 service 需补 export**，boot 验证在 Task 8）。settleBackground 为 public async（供 Task 6），JSDoc 注明「调用方持槽，本方法 finally 释放」。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm jest apps/server-agent/src/services/dispatch-subagent.service.spec.ts`
Expected: 全绿（既有 9 + 新增 ≥10）。

- [ ] **Step 5: 提交**

```bash
git add apps/server-agent/src/services/dispatch-subagent.service.ts \
        apps/server-agent/src/services/dispatch-subagent.service.spec.ts \
        apps/server-agent/src/services/model-config.service.ts \
        apps/server-agent/src/ws/session.gateway.ts
git commit -m "feat(server-agent): dispatch_subagent 后台派发（settle 链：播报回灌+tool 行重写+settled 事件）+ 终态判定表 + model 解析

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 重启恢复 — boot 扫描 background=1 复用 settle

**Files:**
- Modify: `apps/server-agent/src/services/dispatch-subagent.service.ts`
- Test: `apps/server-agent/src/services/dispatch-subagent.service.spec.ts`

**Interfaces:**
- Consumes: Task 2 `listPendingBackgroundSubagentsUnscoped` + Task 5 `settleBackground`。
- Produces: `DispatchSubagentService implements OnApplicationBootstrap`（在 RunnerService.onModuleInit 的 processing→pending 回滚之后执行——Nest 生命周期保证 Bootstrap 晚于所有 ModuleInit）。

- [ ] **Step 1: 写失败测试**

```ts
describe("重启恢复", () => {
  it("boot 扫描 background=1：逐个建账号上下文并 settle（过信号量）", async () => {
    const { service, sessions, deps } = make();
    sessions.listPendingBackgroundSubagentsUnscoped = jest.fn().mockResolvedValue([
      { id: "sub-1", parentSessionId: "p1", parentToolCallId: "tc-1", title: "任务甲", cloudUserId: "u1" },
      { id: "sub-2", parentSessionId: "p2", parentToolCallId: "tc-2", title: "任务乙", cloudUserId: "u2" },
    ]);
    const settled: string[] = [];
    jest.spyOn(service, "settleBackground").mockImplementation(async (args) => {
      // 断言运行在对应账号上下文内
      settled.push(`${deps.account.get()}:${args.subSessionId}`);
    });
    await service.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    expect(settled.sort()).toEqual(["u1:sub-1", "u2:sub-2"]);
  });

  it("无待恢复任务时零动作", async () => {
    const { service, sessions } = make();
    sessions.listPendingBackgroundSubagentsUnscoped = jest.fn().mockResolvedValue([]);
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
```

（`make()`/`deps.account` 以该 spec 现有装配为准——account 是真 `AccountContextService` 实例即可断言上下文；`settleBackground` 的参数对象命名与 Task 5 签名一致。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest apps/server-agent/src/services/dispatch-subagent.service.spec.ts -t "重启恢复"`
Expected: FAIL（onApplicationBootstrap 不存在）。

- [ ] **Step 3: 实现**

```ts
/**
 * 重启恢复：扫描所有账号「待了结的后台子任务」（background=1），逐个在归属账号
 * 上下文内取槽 → settleBackground（kickAndWait 对无 pending 的会话是 no-op，
 * 天然覆盖「宕机时没跑完→续跑」与「跑完但播报丢失→补播报」两分支）。
 * fire-and-forget：恢复不阻塞启动；单任务失败只记日志。
 */
async onApplicationBootstrap(): Promise<void> {
  const rows = await this.sessions.listPendingBackgroundSubagentsUnscoped();
  if (rows.length === 0) return;
  this.logger.log(`重启恢复：发现 ${rows.length} 个待了结后台子任务`);
  for (const row of rows) {
    if (!row.parentSessionId || !row.parentToolCallId) continue;
    void this.account
      .run(row.cloudUserId, async () => {
        await this.semaphore().acquire();
        await this.settleBackground({
          subSessionId: row.id,
          parentSessionId: row.parentSessionId as string,
          parentToolCallId: row.parentToolCallId as string,
          description: row.title ?? "后台任务",
        });
      })
      .catch((err) =>
        this.logger.warn(`重启恢复 settle 失败 sub=${row.id}`, err),
      );
  }
}
```

类声明加 `implements OnApplicationBootstrap`（`@nestjs/common` import）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm jest apps/server-agent/src/services/dispatch-subagent.service.spec.ts`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/server-agent/src/services/dispatch-subagent.service.ts \
        apps/server-agent/src/services/dispatch-subagent.service.spec.ts
git commit -m "feat(server-agent): 后台子任务重启恢复（boot 扫描 background=1 复用 settle）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: web-agent — 停止按钮 + running 态 + settled 消费

**Files:**
- Modify: `apps/web-agent/src/lib/subagent-card.ts`、`apps/web-agent/src/lib/subagent-card.spec.ts`、`apps/web-agent/src/hooks/use-session-stream.ts`、`apps/web-agent/src/components/session/subagent-card.tsx`、`apps/web-agent/messages/zh.json`、`apps/web-agent/messages/en.json`

**Interfaces:**
- Consumes: Task 1 `RunSubagentSettledEvent`/常量；1b 的 `claimSubagentOnTimeline` idiom、`SubagentCollapse`、`useSessionStream.interrupt()`。
- Produces: 纯函数 `settleSubagentOnTimeline<T>(prev: T[], toolCallId: string, resultJson: string): T[]`（命中含该 toolCall 的条目把 `result` 置为 resultJson；未命中返回原引用）；`resolveSubagentStatus` 认识 `"running"`。

- [ ] **Step 1: 写失败测试（纯函数，零 import 纪律）**

`subagent-card.spec.ts` 追加：

```ts
describe("resolveSubagentStatus 后台 running 态", () => {
  it("结果 JSON status=running：子流在跑 → running；子流已停 → done（间隙兜底）", () => {
    expect(resolveSubagentStatus({ status: "ok", result: '{"status":"running"}' }, true)).toBe("running");
    expect(resolveSubagentStatus({ status: "ok", result: '{"status":"running"}' }, false)).toBe("done");
  });
});

describe("settleSubagentOnTimeline", () => {
  const timeline: Array<{
    id: string;
    toolCalls?: Array<{ toolCallId: string; result?: string }>;
  }> = [
    { id: "m1", toolCalls: [{ toolCallId: "tc-1", result: '{"status":"running"}' }] },
    { id: "m2" },
  ];
  it("按 toolCallId 重写 result，其余不动", () => {
    const next = settleSubagentOnTimeline(timeline, "tc-1", '{"status":"aborted","output":""}');
    expect(next[0].toolCalls?.[0].result).toBe('{"status":"aborted","output":""}');
    expect(next[1]).toBe(timeline[1]);
  });
  it("未命中返回原数组引用", () => {
    expect(settleSubagentOnTimeline(timeline, "tc-404", "{}")).toBe(timeline);
  });
});
```

（import 行加 `settleSubagentOnTimeline`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm jest apps/web-agent/src/lib/subagent-card.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现纯函数**

`subagent-card.ts`：`resolveSubagentStatus` 的 parsed 判定加一支（在 done/error/aborted 判定之前）：

```ts
      if (parsed.status === "running") {
        // 后台派发的立即返回态：真实状态由子流/settled 事件驱动；
        // 子流已停但 settled 尚未到（毫秒级间隙）按 done 兜底。
        return childRunning ? "running" : "done";
      }
```

新增（放 `claimSubagentOnTimeline` 之后，同款泛型/引用语义）：

```ts
/**
 * 后台子任务终态打标：按 toolCallId 把工具条目的 result 重写为终局 JSON
 * （消费 run.subagent_settled）。未命中返回原数组引用。
 */
export function settleSubagentOnTimeline<
  T extends { toolCalls?: Array<{ toolCallId: string; result?: string }> },
>(prev: T[], toolCallId: string, resultJson: string): T[] {
  let changed = false;
  const next = prev.map((m) => {
    if (!m.toolCalls?.some((t) => t.toolCallId === toolCallId)) return m;
    changed = true;
    // 泛型展开覆写属性后 TS 无法证明仍是 T，运行时结构未变，安全收窄
    return {
      ...m,
      toolCalls: m.toolCalls.map((t) =>
        t.toolCallId === toolCallId ? { ...t, result: resultJson } : t,
      ),
    } as T;
  });
  return changed ? next : prev;
}
```

- [ ] **Step 4: hook 接线 + 停止按钮 + i18n**

`use-session-stream.ts`（对称 1b 的 spawned 三处）：import 加 `RunSubagentSettledEvent` 类型与 `settleSubagentOnTimeline`；`onSubagentSpawned` 后加：

```ts
const onSubagentSettled = (e: RunSubagentSettledEvent) => {
  if (e.sessionId !== sessionId) return;
  apply((prev) =>
    settleSubagentOnTimeline(
      prev,
      e.toolCallId,
      JSON.stringify({ subSessionId: e.subSessionId, status: e.status, output: e.output }),
    ),
  );
};
```

注册/清理成对：`socket.on(SESSION_WS_EVENTS.runSubagentSettled, onSubagentSettled);` / `socket.off(...)`（紧跟 spawned 两行之后）。

`subagent-card.tsx`：头部改「折叠按钮 + 停止按钮」并排（**不得嵌套 button**）——现有 `<button …>` 外包一层 `<div className="flex w-full items-center">`，原 button 加 `flex-1 min-w-0`（保留原有全部内容与类），其后加：

```tsx
{active && subSessionId && (
  <button
    type="button"
    onClick={() => sub.interrupt()}
    title={t("stop")}
    className="shrink-0 px-2 py-1.5 text-muted-foreground hover:text-destructive"
  >
    <Square className="h-3 w-3" />
  </button>
)}
```

（`Square` 加进 lucide import；`active` 为既有变量。）i18n 两份 `session.subagent` 内加 `"stop": "停止"` / `"stop": "Stop"`。

- [ ] **Step 5: 验证**

Run:
```bash
pnpm jest apps/web-agent/src/lib
pnpm --filter @meshbot/web-agent typecheck
tsx scripts/sync-locales.ts -- --check
```
Expected: 全绿；locales missing=0/asymmetric=0。

- [ ] **Step 6: 提交**

```bash
git add apps/web-agent/src/lib/subagent-card.ts apps/web-agent/src/lib/subagent-card.spec.ts \
        apps/web-agent/src/hooks/use-session-stream.ts \
        apps/web-agent/src/components/session/subagent-card.tsx \
        apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): 嵌套卡停止按钮 + 后台 running 态 + settled 终态消费

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 集成验证（全量 + boot 含新迁移 + 冒烟 + 真实重启恢复）

- [ ] **Step 1: 全量**

Run: `pnpm typecheck && pnpm test && pnpm --filter @meshbot/agent test 2>&1 | tail -5`
Expected: typecheck 26/26；根 jest 全绿+1 skip 无新增失败；libs/agent vitest 失败数=基线（9 个预存在），只看新增。

- [ ] **Step 2: 围栏 + Biome**

Run: `pnpm check && pnpm format && pnpm lint`
Expected: 全 0 问题（`listPendingBackgroundSubagentsUnscoped` 的 `// scope-check: allow-unscoped` 注释生效；无事务/命名违例）。

- [ ] **Step 3: 隔离 boot（新迁移必验）**

照 1a Task 8 Step 3 流程（`MESHBOT_HOME="$(mktemp -d)"`，勿碰仓库根 `.meshbot/`）：确认迁移 `AddSessionBackgroundAndModel` 跑过（stdout 有两条 ALTER TABLE）、DI 无错（DispatchSubagentService 新注入 ModelConfigService、RunnerService 新注入 ModelRunContext 均解析）、health 200、启动日志无「重启恢复」误触发（全新库无 background=1）。

- [ ] **Step 4: dev 冒烟（需用户 dev 库模型配置；REST 方法照 .superpowers/sdd/task-5-report.md Step 4）**

1. **后台链路**：发消息让主 Agent `dispatch_subagent` 且 `background:true`——断言 dispatch 工具条目 result 立即为 `{"status":"running"}`；轮询父 history 直到出现播报 user 消息（含「已完成」）与主 Agent 汇报；该工具条目 result 已被重写为终局 JSON。
2. **model 覆盖**：dev 库若有 ≥2 个模型配置，派发时指定非默认 `model`，断言子会话 `llm_calls.model` 为指定型号且父会话仍为默认型号（llm_calls 双向核对=meta 修复的实证）；只有 1 个配置则指定不存在的名字断言 error JSON。
3. **真实重启恢复**：派一个耗时后台任务（如「写 500 字短文」）→ 在子 run 进行中 kill dev server 进程 → 重启 `pnpm dev:server-agent` → 断言启动日志出现「重启恢复：发现 1 个」、子会话续跑完成、父会话收到播报、`background=0`（sqlite3 只读核对）。
4. **停止**：再派一个后台任务，调 WS interrupt（或 UI 点停止）→ 播报「已中止」。
5. 清理全部测试会话（DELETE 父+子，sqlite3 核零）。

- [ ] **Step 5: UI 人工验收清单（交用户）**

1. 后台派发：卡片立即出现且显示「运行中」，父流不阻塞可继续对话；
2. 子完成：父流出现播报气泡 + 主 Agent 汇报；卡片自动收起、徽标「已完成」；
3. 刷新（后台运行中/完成后）：卡片状态正确还原；
4. 停止按钮：运行中可见，点击后卡片变「已中止」、播报「已中止」；
5. model 覆盖任务的嵌套卡正常滴流；
6. 中英文文案正常。

- [ ] **Step 6: 收尾提交（如有格式化改动）**

```bash
git add -A
git commit -m "chore: 派子 Agent Phase 2 收尾（格式化 + 围栏）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review（计划自审）

- **Spec 覆盖**：§3 两列迁移→T2；§4 后台分支/settle 链（播报/重写/settled/置0/槽转移）→T5；§4 终态判定表（含前台升级）→T5；§5 重启恢复→T6；§6 model 覆盖（解析/持久化/ALS/meta 修）→T2+T3+T4+T5；§7 前端（停止/running 态/settled 消费）→T7；§9 测试矩阵→各任务+T8；§10 不做清单→未出现。播报「重试一次仍失败保持 background=1」→T5 规格 4；「父已删置 0」→T5 规格 4。
- **占位符扫描**：无 TBD/TODO。「以文件现状为准」限于既有装配细节（repo 变量名、mock 造数、recordToolResult 签名、DispatchSubagentModule imports），均为必要现场核对点。
- **类型一致性**：`RunSubagentSettledEvent`（T1）= gateway 转发（T5）= 前端消费（T7）字段一致；`settleBackground(args)` 签名 T5 定义、T6 复用；`createSubSession` 扩展字段 T2 定义、T5 传入；`ModelRunContext` API T3 定义、T4 包裹、T3 的 resolver 消费；`updateToolResult` 返回 number（T2）与 T5 的 0 重试语义一致；`findByIdOrName`（T5 内定义与消费）。
- **风险点已内置**：ALS 生成器陷阱（T4 铁律+回归测试）；ModelResolver 构造签名变化的全装配对齐（T3 Step 4 明确 grep）；服务新依赖的 spec mock 补齐（T5 Step 1 注明）；tool 行落库竞速重试（T5 规格 4）。
