# Per-Account Checkpoint DB + 根库改名 main.db 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 LangGraph SqliteSaver checkpointer 从共享根库（agent.db）拆到各账号专属库（accounts/<cloudUserId>/agent.db），根库改名 main.db，彻底消除 SqliteSaver 与 TypeORM 争锁导致的 SQLITE_BUSY。

**Architecture:** GraphService 由单例 eager 建图改为 per-account 懒建+缓存（`graphsByAccount` Map），每账号各自的 `accounts/<id>/agent.db` 持有 LangGraph checkpoints/writes，TypeORM 连接指向 `main.db`，二者物理分库不再争锁。启动时一次性 rename 迁移旧 agent.db → main.db（仅当 main.db 不存在时）。登出时 `evictAccount` 关闭 checkpointer 连接。

**Tech Stack:** NestJS/TypeORM（SQLite/better-sqlite3）、LangGraph SqliteSaver（@langchain/langgraph-checkpoint-sqlite）、Vitest（libs/agent 单测）、Jest（server-agent 单测）。

## Global Constraints

- 不改 model 逻辑，`readActiveModelConfig(getDatabasePath())` 读根库 main.db 不变。
- `clearThread` 每条 DELETE 单独 try/catch，表未建时视作无可删。
- 启动 rename 必须在 NestFactory.create 之前（任何 DB 连接之前）。
- brief 末尾 commit message 格式：`feat(server-agent): LangGraph checkpoint 拆到各账号库(accounts/<id>/agent.db) + 根库改名 main.db`。
- 跑完 biome --write 再提交；不能 --no-verify 跳 pre-commit。

---

## 文件改动一览

| 文件 | 操作 |
|------|------|
| `libs/agent/src/config/meshbot-config.service.ts` | 改 `getDatabasePath` 返回 `main.db`；新增 `getAccountCheckpointDbPath()` |
| `libs/agent/src/graph/graph.service.ts` | 删 eager 建图；加 `graphsByAccount` Map + `accountGraph()`；9 处 `this.graph` → `this.accountGraph().graph`；新增 `clearThread`/`evictAccount` |
| `apps/server-agent/src/services/checkpointer-cleanup.service.ts` | 去掉 DataSource 注入，注入 GraphService，委托 `clearThread` |
| `apps/server-agent/src/app.module.ts` | `agent.db` → `main.db` |
| `apps/server-agent/src/data-source.cli.ts` | `agent.db` → `main.db` |
| `apps/server-agent/src/main.ts` | 启动时 rename 旧 agent.db → main.db（含 WAL/shm 边车） |
| `apps/server-agent/src/account/account-runtime.registry.ts` | 注入 GraphService；`teardownRuntime` 调 `evictAccount` |
| `libs/agent/tests/unit/meshbot-config.service.test.ts` | 更新 `agent.db` 断言 → `main.db`；新增 `getAccountCheckpointDbPath` 用例 |
| `libs/agent/src/config/meshbot-config.service.spec.ts` | 更新 `agent.db` → `main.db` 断言 |
| `apps/server-agent/src/services/checkpointer-cleanup.service.spec.ts` | 改为 mock GraphService.clearThread |

---

### Task 1：MeshbotConfigService — getDatabasePath → main.db + 新增 getAccountCheckpointDbPath

**Files:**
- Modify: `libs/agent/src/config/meshbot-config.service.ts`

**Interfaces:**
- Produces: `getDatabasePath(): string` → `<meshbotDir>/main.db`；`getAccountCheckpointDbPath(): string` → `<meshbotDir>/accounts/<id>/agent.db`（需账号上下文）

- [ ] **Step 1: 修改 `getDatabasePath` + 新增 `getAccountCheckpointDbPath`**

在 `libs/agent/src/config/meshbot-config.service.ts` 中，把第 98-100 行的 `getDatabasePath()` JSDoc 和实现替换为：

```ts
  /**
   * 本地 SQLite 数据库路径（根库）：<meshbotDir>/main.db。
   * 固定共享——所有账号同库（行级 cloudUserId 隔离），不随账号变；
   * 模块初始化期（无账号上下文）也会被调用，故不能账号化。
   */
  getDatabasePath(): string {
    return path.join(this.meshbotDir, "main.db");
  }

  /**
   * 当前账号的 LangGraph checkpoint 库：<meshbotDir>/accounts/<account>/agent.db。
   * 与 TypeORM 根库（main.db）物理分离，避免 SqliteSaver 与 TypeORM 争锁；按账号隔离。
   * 必须在账号上下文内调用（accountDir 用 getOrThrow）。
   */
  getAccountCheckpointDbPath(): string {
    return path.join(this.accountDir(), "agent.db");
  }
```

（`accountDir()` 已存在，自动 mkdir，可直接用。）

- [ ] **Step 2: 运行 typecheck 确认无报错**

```bash
cd /Users/grant/Meta1/meshbot
pnpm --filter @meshbot/agent typecheck 2>&1 | tail -20
```

Expected: 无错误（或仅前置错误，本步不引入新错误）

---

### Task 2：更新 libs/agent 相关 tests — main.db 断言 + getAccountCheckpointDbPath 用例

**Files:**
- Modify: `libs/agent/tests/unit/meshbot-config.service.test.ts`
- Modify: `libs/agent/src/config/meshbot-config.service.spec.ts`

- [ ] **Step 1: 更新 `tests/unit/meshbot-config.service.test.ts`**

找到两处 `agent.db` 断言并更新：

```ts
// 第 21 行附近 — 更新 "returns database path" 用例
it("returns database path（共享，不依赖账号上下文）", () => {
  const dbPath = makeService().getDatabasePath();
  expect(dbPath).toContain(".meshbot");
  expect(dbPath).toContain("main.db");          // 原: agent.db → main.db
});
```

```ts
// 第 58 行附近 — 更新 MESHBOT_HOME 覆盖用例里的断言
expect(service.getDatabasePath()).toBe(path.join(root, "main.db")); // 原: agent.db → main.db
```

同文件新增 `getAccountCheckpointDbPath` 用例（在现有 describe 块末尾）：

```ts
  it("getAccountCheckpointDbPath 在账号上下文内返 accounts/<id>/agent.db", () => {
    const root = "/tmp/meshbot-per-account-test-home";
    process.env.MESHBOT_HOME = root;  // 注：afterEach 已恢复

    const ctx = new AccountContextService();
    const service = new MeshbotConfigService(ctx);

    ctx.run("acc-1", () => {
      const p = service.getAccountCheckpointDbPath();
      expect(p).toBe(path.join(root, "accounts", "acc-1", "agent.db"));
    });
  });

  it("getAccountCheckpointDbPath 无账号上下文抛错", () => {
    const ctx = new AccountContextService();
    const service = new MeshbotConfigService(ctx);
    expect(() => service.getAccountCheckpointDbPath()).toThrow();
  });
```

（注意这两个 it 里都设了 MESHBOT_HOME，需要确保 afterEach 恢复——参照文件里已有的 afterEach 模式，MESHBOT_HOME 覆盖 describe 已有 afterEach 恢复，可直接在里面新增；或者把新用例放进同一个 `describe("MeshbotConfigService MESHBOT_HOME 覆盖"` 块）

- [ ] **Step 2: 更新 `src/config/meshbot-config.service.spec.ts`**

找到 `agent.db` 断言（第 50/58 行附近），把 `agent.db` 改为 `main.db`：

```ts
// 原:
expect(a.endsWith("/agent.db")).toBe(true);
// 改为:
expect(a.endsWith("/main.db")).toBe(true);
```

- [ ] **Step 3: 运行 vitest 确认测试通过**

```bash
cd /Users/grant/Meta1/meshbot
pnpm --filter @meshbot/agent test 2>&1 | tail -30
```

Expected: meshbot-config 相关用例全绿；其余用例不应因此变红（此时 graph.service 还没改，如果 eager 建图，会去找 getAccountCheckpointDbPath，但测试里 graph 还不依赖它，不受影响）

---

### Task 3：GraphService — per-account 懒建+缓存 + clearThread + evictAccount

**Files:**
- Modify: `libs/agent/src/graph/graph.service.ts`

**Interfaces:**
- Consumes: `configService.getAccountCheckpointDbPath(): string`；`account.getOrThrow(): string`
- Produces:
  - `private accountGraph(): { graph, checkpointer }` — 懒建缓存
  - `clearThread(threadId: string): void` — 删账号 checkpoint 库的 checkpoints/writes
  - `evictAccount(cloudUserId: string): void` — 关闭并移除账号 checkpointer 连接

- [ ] **Step 1: 替换字段声明（第 92-93 行附近）**

删除现有：
```ts
  private checkpointer: ReturnType<typeof createSqliteCheckpointer>;
  private graph: ReturnType<typeof buildSupervisorGraph>;
```

替换为：
```ts
  /** 按账号缓存的 {graph, checkpointer}：checkpointer 指向该账号 accounts/<id>/agent.db。 */
  private readonly graphsByAccount = new Map<
    string,
    {
      graph: ReturnType<typeof buildSupervisorGraph>;
      checkpointer: ReturnType<typeof createSqliteCheckpointer>;
    }
  >();
```

- [ ] **Step 2: 删除构造里 eager 建图代码（第 121-133 行附近）**

删除以下三行（保留其余构造内容，`this.modelProvider` / `this.modelMeta` 保留）：
```ts
    const dbPath = this.configService.getDatabasePath();
    this.checkpointer = createSqliteCheckpointer(dbPath);
    // ...（注释行）
    this.graph = buildSupervisorGraph(
      this.checkpointer,
      this.modelProvider,
      this.toolRegistry,
      this.eventEmitter,
    );
```

构造结果变为只设 `this.modelProvider` 和 `this.modelMeta`。

- [ ] **Step 3: 在 resolveModel 上方（大约 142 行前）新增 `accountGraph()` 私有方法**

```ts
  /** 解析当前账号的 graph+checkpointer（首次建、之后缓存）。须在账号上下文内调用。 */
  private accountGraph(): {
    graph: ReturnType<typeof buildSupervisorGraph>;
    checkpointer: ReturnType<typeof createSqliteCheckpointer>;
  } {
    const acct = this.account.getOrThrow();
    let entry = this.graphsByAccount.get(acct);
    if (!entry) {
      const checkpointer = createSqliteCheckpointer(
        this.configService.getAccountCheckpointDbPath(),
      );
      const graph = buildSupervisorGraph(
        checkpointer,
        this.modelProvider,
        this.toolRegistry,
        this.eventEmitter,
      );
      entry = { graph, checkpointer };
      this.graphsByAccount.set(acct, entry);
    }
    return entry;
  }
```

- [ ] **Step 4: 把 9 处 `this.graph` 替换为 `this.accountGraph().graph`**

用全局搜索替换（所有 `this.graph.` → `this.accountGraph().graph.`，以及 `await this.graph.stream` → `await this.accountGraph().graph.stream` 等）。

具体位置（对应 brief 中提到的行号，可能因前步改动有偏移，逐一确认）：
- `streamMessageImpl` 里：`await this.graph.getState(` → `await this.accountGraph().graph.getState(`
- `sanitizeOrphanToolCalls` 里：两处 `this.graph.getState` 和 `this.graph.updateState`
- `cutMessagesAfter` 里：`this.graph.getState` 和 `this.graph.updateState`
- `getMessagesSnapshot` 里：`this.graph.getState`
- `applyCompaction` 里：`this.graph.updateState`
- `runGraphStream` 里：`this.graph.stream`

（`readActiveModelConfig(this.configService.getDatabasePath())` 保持不变，读根库 main.db）

- [ ] **Step 5: 在文件末尾（`resolveRecursionLimit` 函数前，或 class 末尾）新增 clearThread + evictAccount**

在 `GraphService` 类的末尾、`roleOf` 方法之后，`}` 之前添加：

```ts
  /**
   * 删除某 thread（=sessionId）在当前账号 checkpoint 库的 checkpoints/writes。
   * 账号上下文内调用。每条 DELETE 单独 try/catch：表未建时视作无可删。
   */
  clearThread(threadId: string): void {
    const db = this.accountGraph().checkpointer.db;
    try {
      db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
    } catch {
      // 表不存在时 SqliteSaver 尚未 setup，视作无可删
    }
    try {
      db.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);
    } catch {
      // 同上
    }
  }

  /**
   * 登出/拆账号运行时：关闭并移除该账号的 checkpoint 连接，避免连接泄漏。幂等。
   */
  evictAccount(cloudUserId: string): void {
    const entry = this.graphsByAccount.get(cloudUserId);
    if (!entry) return;
    try {
      entry.checkpointer.db.close();
    } catch {
      // 已关/异常忽略
    }
    this.graphsByAccount.delete(cloudUserId);
  }
```

- [ ] **Step 6: 确认 `SqliteSaver` 类型有公开的 `.db` 属性**

```bash
grep -n "db" /Users/grant/Meta1/meshbot/node_modules/.pnpm/@langchain+langgraph-checkpoint-sqlite*/node_modules/@langchain/langgraph-checkpoint-sqlite/dist/*.d.ts 2>/dev/null | head -10
```

若 `.db` 是 `protected` 或不存在，改为通过 `(entry.checkpointer as unknown as { db: import("better-sqlite3").Database }).db` 强转。

- [ ] **Step 7: 运行 typecheck**

```bash
cd /Users/grant/Meta1/meshbot
pnpm --filter @meshbot/agent typecheck 2>&1 | tail -30
```

Expected: 无新增类型错误

---

### Task 4：更新 graph.service 测试（vitest）— 适配 per-account 懒建

**Files:**
- Modify: `libs/agent/tests/unit/graph.service.test.ts`
- Modify: `libs/agent/tests/unit/graph-compaction.test.ts`

现状：测试已在 `ctx.run(TEST_ACCOUNT, ...)` 内调 `streamMessage`/`resumeStream` 等，符合账号上下文要求。`GraphService` 构造时不再 eager 建图，构造本身不再访问 DB。需要确认：

- `graphService = new GraphService(...)` 构造不会抛错（不再 eager 建图，构造不访问 DB）
- 所有调 `streamMessage`/`getHistory`/`applyCompaction`/`getMessagesSnapshot` 的测试都已在 `ctx.run(TEST_ACCOUNT, ...)` 内 ✓

- [ ] **Step 1: 确认 graph.service.test.ts 里构造后没有直接（非 ctx.run 内）调用 graphService 方法的用例**

```bash
grep -n "graphService\." /Users/grant/Meta1/meshbot/libs/agent/tests/unit/graph.service.test.ts | grep -v "ctx.run\|async () =>"
```

若有直接调用（在 `ctx.run` 外），需包进 `await ctx.run(TEST_ACCOUNT, async () => { ... })`。

- [ ] **Step 2: 确认 graph-compaction.test.ts 中 graphService 调用均在 ctx.run 内**

```bash
grep -n "graphService\." /Users/grant/Meta1/meshbot/libs/agent/tests/unit/graph-compaction.test.ts | head -30
```

若 `getMessagesSnapshot` / `applyCompaction` 调用不在 `ctx.run` 内，包起来：

```ts
// 示例：如果有裸调用，改为：
await ctx.run(TEST_ACCOUNT, async () => {
  const msgs = await graphService.getMessagesSnapshot(threadId);
  // ...断言
});
```

- [ ] **Step 3: 运行 vitest 全套**

```bash
cd /Users/grant/Meta1/meshbot
pnpm --filter @meshbot/agent test 2>&1 | tail -40
```

Expected: 全绿（或绿色用例数与改前相同，不新增失败）

---

### Task 5：CheckpointerCleanupService — 改委托 GraphService

**Files:**
- Modify: `apps/server-agent/src/services/checkpointer-cleanup.service.ts`
- Modify: `apps/server-agent/src/services/checkpointer-cleanup.service.spec.ts`

- [ ] **Step 1: 重写 checkpointer-cleanup.service.ts**

```ts
import { GraphService } from "@meshbot/agent";
import { Injectable } from "@nestjs/common";

/**
 * 清 LangGraph SqliteSaver 的 checkpoints / writes 表。
 * 委托给 GraphService.clearThread（账号专属 checkpointer 库），
 * 无需直接访问 DataSource。账号上下文内被调（session.service 调用链已在上下文内）。
 */
@Injectable()
export class CheckpointerCleanupService {
  constructor(private readonly graph: GraphService) {}

  /** 删某 thread_id 的全部 checkpoints + writes。幂等：不存在不报错。 */
  deleteThread(threadId: string): void {
    this.graph.clearThread(threadId);
  }
}
```

（注意：`clearThread` 是同步方法，`deleteThread` 不再是 async，但调用方 `session.service` 很可能 `await deleteThread(...)`，同步方法被 await 不报错。若调用方强依赖 Promise，可保留 async 返回 `Promise<void>` 包裹。检查调用点：）

```bash
grep -rn "deleteThread\|checkpointerCleanup" /Users/grant/Meta1/meshbot/apps/server-agent/src/ 2>/dev/null | grep -v spec
```

若调用方有 `await service.deleteThread(...)` 且用了返回值，保持方法为 async：
```ts
  async deleteThread(threadId: string): Promise<void> {
    this.graph.clearThread(threadId);
  }
```

- [ ] **Step 2: 重写 checkpointer-cleanup.service.spec.ts**

```ts
import { GraphService } from "@meshbot/agent";
import { CheckpointerCleanupService } from "./checkpointer-cleanup.service";

describe("CheckpointerCleanupService", () => {
  let graph: jest.Mocked<Pick<GraphService, "clearThread">>;
  let service: CheckpointerCleanupService;

  beforeEach(() => {
    graph = { clearThread: jest.fn() };
    service = new CheckpointerCleanupService(
      graph as unknown as GraphService,
    );
  });

  it("deleteThread 委托 graph.clearThread(threadId)", async () => {
    await service.deleteThread("t1");
    expect(graph.clearThread).toHaveBeenCalledWith("t1");
    expect(graph.clearThread).toHaveBeenCalledTimes(1);
  });

  it("deleteThread 对任意 thread_id 不报错（幂等）", async () => {
    await expect(service.deleteThread("nope")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: 运行 jest 确认测试通过**

```bash
cd /Users/grant/Meta1/meshbot
pnpm test -- "checkpointer-cleanup" 2>&1 | tail -20
```

Expected: 2 个用例 PASS

---

### Task 6：app.module + data-source.cli 路径改名（agent.db → main.db）

**Files:**
- Modify: `apps/server-agent/src/app.module.ts`（第 81 行）
- Modify: `apps/server-agent/src/data-source.cli.ts`（第 22 行）

- [ ] **Step 1: app.module.ts**

把第 81 行：
```ts
      database: path.join(meshbotDir, "agent.db"),
```
改为：
```ts
      database: path.join(meshbotDir, "main.db"),
```

- [ ] **Step 2: data-source.cli.ts**

把第 22 行：
```ts
  database: path.join(MESHBOT_DIR, "agent.db"),
```
改为：
```ts
  database: path.join(MESHBOT_DIR, "main.db"),
```

同时更新文件顶部注释中的 `agent.db` 提及（第 7 行）：
```ts
 * SQLite 文件位置：`~/.meshbot/main.db`（与 runtime 一致）。
```

- [ ] **Step 3: typecheck**

```bash
cd /Users/grant/Meta1/meshbot
pnpm --filter @meshbot/server-agent typecheck 2>&1 | tail -20
```

Expected: 无新增错误

---

### Task 7：main.ts — 启动时一次性 rename agent.db → main.db

**Files:**
- Modify: `apps/server-agent/src/main.ts`

- [ ] **Step 1: 在 `bootstrap()` 函数里 `NestFactory.create(AppModule)` 之前添加 rename 逻辑**

在 `main.ts` 的 import 区加（若未有）：
```ts
import { existsSync, mkdirSync, renameSync } from "node:fs";
```

（已有 `mkdirSync`，只需补 `existsSync` 和 `renameSync`。）

在 `mkdirSync(path.join(meshbotDir, "logs"), { recursive: true });` 之后、`const port = ...` 之前插入：

```ts
  // 一次性迁移：根库 agent.db → main.db（仅当 main.db 不存在且 agent.db 存在）。
  const legacyDb = path.join(meshbotDir, "agent.db");
  const mainDb = path.join(meshbotDir, "main.db");
  if (existsSync(legacyDb) && !existsSync(mainDb)) {
    renameSync(legacyDb, mainDb);
    // WAL/shm 边车文件一并搬（若存在）
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(legacyDb + ext)) renameSync(legacyDb + ext, mainDb + ext);
    }
  }
```

- [ ] **Step 2: typecheck**

```bash
cd /Users/grant/Meta1/meshbot
pnpm --filter @meshbot/server-agent typecheck 2>&1 | tail -20
```

---

### Task 8：AccountRuntimeRegistry — 注入 GraphService + evictAccount

**Files:**
- Modify: `apps/server-agent/src/account/account-runtime.registry.ts`

**Interfaces:**
- Consumes: `GraphService.evictAccount(cloudUserId: string): void`

- [ ] **Step 1: 注入 GraphService 并在 teardownRuntime 调 evictAccount**

在 import 区加：
```ts
import { AccountContextService, GraphService, McpService, PromptService } from "@meshbot/agent";
```
（原本只 import `AccountContextService, McpService, PromptService`，追加 `GraphService`）

在 constructor 中追加参数：
```ts
  constructor(
    private readonly ctx: AccountContextService,
    private readonly mcp: McpService,
    private readonly prompt: PromptService,
    private readonly relay: ImRelayClientService,
    private readonly emitter: EventEmitter2,
    private readonly graph: GraphService,   // 新增
  ) {}
```

在 `teardownRuntime` 方法里（`this.live.delete(cloudUserId)` 之前）添加：
```ts
    try {
      this.graph.evictAccount(cloudUserId);
    } catch (err) {
      this.logger.error(`evictAccount ${cloudUserId} 失败`, err as Error);
    }
```

- [ ] **Step 2: 更新 account-runtime.registry.spec.ts**

在 spec 的 `beforeEach` 里 mock GraphService：
```ts
  let graph: jest.Mocked<Pick<GraphService, "evictAccount">>;
  // ...
  graph = { evictAccount: jest.fn() };
  registry = new AccountRuntimeRegistry(
    ctx,
    mcp as unknown as import("@meshbot/agent").McpService,
    prompt as unknown as import("@meshbot/agent").PromptService,
    relay as unknown as import("../cloud/im-relay-client.service").ImRelayClientService,
    emitter,
    graph as unknown as GraphService,   // 新增
  );
```

在 `teardownRuntime` 测试组里新增断言：
```ts
    it("teardownRuntime 调 graph.evictAccount(cloudUserId)", async () => {
      await registry.createRuntime("u1");
      await registry.teardownRuntime("u1");
      expect(graph.evictAccount).toHaveBeenCalledWith("u1");
    });
```

- [ ] **Step 3: 运行 jest（account-runtime.registry spec）**

```bash
cd /Users/grant/Meta1/meshbot
pnpm test -- "account-runtime.registry" 2>&1 | tail -20
```

Expected: 全绿（包含新断言）

---

### Task 9：全量验证 + biome + 提交

- [ ] **Step 1: 全量 typecheck**

```bash
cd /Users/grant/Meta1/meshbot
pnpm --filter @meshbot/agent --filter @meshbot/server-agent typecheck 2>&1 | tail -30
```

Expected: 0 errors

- [ ] **Step 2: vitest 全绿**

```bash
cd /Users/grant/Meta1/meshbot
pnpm --filter @meshbot/agent test 2>&1 | tail -30
```

Expected: 全绿

- [ ] **Step 3: jest 相关测试全绿**

```bash
cd /Users/grant/Meta1/meshbot
pnpm test -- "checkpointer-cleanup|meshbot-config|account-runtime.registry" 2>&1 | tail -30
```

Expected: 全绿

- [ ] **Step 4: biome 格式化所有改动文件**

```bash
cd /Users/grant/Meta1/meshbot
pnpm exec biome check --write \
  libs/agent/src/config/meshbot-config.service.ts \
  libs/agent/src/graph/graph.service.ts \
  libs/agent/tests/unit/meshbot-config.service.test.ts \
  libs/agent/src/config/meshbot-config.service.spec.ts \
  apps/server-agent/src/services/checkpointer-cleanup.service.ts \
  apps/server-agent/src/services/checkpointer-cleanup.service.spec.ts \
  apps/server-agent/src/app.module.ts \
  apps/server-agent/src/data-source.cli.ts \
  apps/server-agent/src/main.ts \
  apps/server-agent/src/account/account-runtime.registry.ts \
  apps/server-agent/src/account/account-runtime.registry.spec.ts
```

- [ ] **Step 5: git status 确认暂存文件，untracked docs/audits/tx-fence/* 不 add**

```bash
cd /Users/grant/Meta1/meshbot
git status
```

只 add 上面列出的 10 个文件，不包括任何 docs/audits/tx-fence 路径。

- [ ] **Step 6: 创建分支并提交**

```bash
cd /Users/grant/Meta1/meshbot
git checkout -b feat/per-account-checkpoint-db
git add \
  libs/agent/src/config/meshbot-config.service.ts \
  libs/agent/src/graph/graph.service.ts \
  libs/agent/tests/unit/meshbot-config.service.test.ts \
  libs/agent/src/config/meshbot-config.service.spec.ts \
  apps/server-agent/src/services/checkpointer-cleanup.service.ts \
  apps/server-agent/src/services/checkpointer-cleanup.service.spec.ts \
  apps/server-agent/src/app.module.ts \
  apps/server-agent/src/data-source.cli.ts \
  apps/server-agent/src/main.ts \
  apps/server-agent/src/account/account-runtime.registry.ts \
  apps/server-agent/src/account/account-runtime.registry.spec.ts
git commit -m "$(cat <<'EOF'
feat(server-agent): LangGraph checkpoint 拆到各账号库(accounts/<id>/agent.db) + 根库改名 main.db

根因：SqliteSaver（better-sqlite3 同步 busy-wait）与 TypeORM 共用根 agent.db 争锁，
导致 TypeORM 事务无法提交 → SQLITE_BUSY（putWrites）；busy_timeout 治不了同步 busy-wait。

解法：checkpoint 改为各账号物理分库（~/.meshbot/accounts/<id>/agent.db），
TypeORM 根库同步改名 main.db，二者物理分离彻底消除争锁。
GraphService 由单例 eager 建图改为 per-account 懒建+缓存（graphsByAccount Map）。

迁移副作用：
- main.ts 启动时一次性 rename agent.db→main.db（仅 main.db 不存在时），
  含 WAL/shm 边车；旧 checkpoints/writes 表随 agent.db 孤立无害（新 checkpoint 走各账号库）。
- 既有进行中 run 的 checkpoint 续跑能力丢失（极少见，可接受）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: 运行 pre-commit hook，观察结果**

若 pre-commit 失败，按失败内容修复（biome/check:tx 等），再新建 commit（不得 --no-verify）。

---

## 自检：Spec 覆盖

| Spec 要求 | 覆盖任务 |
|-----------|---------|
| `getDatabasePath` → main.db | Task 1 |
| `getAccountCheckpointDbPath` 新增 | Task 1 |
| GraphService 字段改 graphsByAccount | Task 3 Step 1 |
| 构造删 eager 建图 | Task 3 Step 2 |
| `accountGraph()` 私有方法 | Task 3 Step 3 |
| 9 处 `this.graph` → `this.accountGraph().graph` | Task 3 Step 4 |
| `clearThread` 含 try/catch | Task 3 Step 5 |
| `evictAccount` | Task 3 Step 5 |
| CheckpointerCleanupService 改委托 | Task 5 |
| app.module + data-source.cli 路径 | Task 6 |
| main.ts rename | Task 7 |
| AccountRuntimeRegistry.teardownRuntime 调 evictAccount | Task 8 |
| meshbot-config 测试 main.db + getAccountCheckpointDbPath | Task 2 |
| checkpointer-cleanup.service.spec 改 mock GraphService | Task 5 Step 2 |
| vitest 全绿 | Task 4 + Task 9 |
| jest 全绿 | Task 5 + Task 8 + Task 9 |
| biome --write | Task 9 Step 4 |
| 中文 conventional commit | Task 9 Step 6 |
| 分支 feat/per-account-checkpoint-db | Task 9 Step 6 |
| 报告写到 .git/sdd/ | 执行中在报告阶段处理 |
