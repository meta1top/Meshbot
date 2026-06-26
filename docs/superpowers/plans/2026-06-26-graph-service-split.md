# GraphService 上帝类拆分 实施计划（5 单元 + 直接注入，零行为变更）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `libs/agent/src/graph/graph.service.ts`（1071 行）按职责拆成 5 个单一职责单元 + 类型文件，终态直接注入并删除 GraphService，**零行为变更**。

**Architecture:** 自底向上抽取——每个新单元是 NestJS DI 单例、抽取即注入进 GraphService（GraphService 在迁移期当薄 facade 委派）；因抽取的服务是**共享单例**，迁移全程只有一份 checkpointer 连接缓存，消费者可在末尾安全翻转。

**Tech Stack:** NestJS DI / LangGraph / vitest（import 用 `.js` 后缀）。

## Global Constraints

- **零行为变更**：不改任何外部可观察行为；方法体**逐字搬移（cut-paste，不重写逻辑）**，本计划用「move verbatim from graph.service.ts」标注，只对**新文件骨架 / DI 接线 / facade 委派 / 测试构造**展示完整代码。
- **这是重构，TDD 是反的**：已有 `graph.service.test.ts` 是回归网。每个 Task 的验证 = `pnpm --filter @meshbot/agent typecheck`（必要时加 `@meshbot/server-agent`）+ 跑 agent 套件确认**失败集合 == 基线、无新增**（基线 = 9 个预存在失败：agent.module.test 4 + graph.service.test 3 + supervisor.node.test 2；判回归 diff 失败清单不看总数）+ `pnpm check` 全绿。
- **不变量**（每个 Task 都不能破）：① `resolveMessageId` **单实例**（id 三处收口）；② checkpointer 每账号**一条常驻连接、从不关闭**，`clearThread` 复用 `checkpointer.db` 同一 better-sqlite3 连接；③ 所有路径走 `account.getOrThrow()` 账号隔离；④ `system:ctx`/`system:skills` 稳定 id 原地刷新；⑤ `sanitizeOrphanToolCalls` 在 stream/resume 前跑；⑥ StreamChunk 事件序列/字段不变。
- **新服务都是共享单例**：抽取即注入进 GraphService，**不在 GraphService 内部 `new`**（否则末尾翻消费者时会出现两份 AccountGraphProvider → 两条 checkpointer 连接，破不变量②）。
- **基线红保持**：那 3 个 graph.service.test 的 LangChain mock 失败拆分后归位、保持同样的红，本次不修。
- 中文 JSDoc；禁止 `if` 前一行单独注释。分支 `refactor/graph-service-split`，spec 已 commit。

---

## 抽取顺序与依赖（自底向上）

`graph.types`(无依赖) → `ModelResolver`(独立) → `AccountGraphProvider`(依赖 ModelResolver 取 provider 建图) → `ContextBuilder`(独立) → `ThreadStateService`(依赖 AccountGraphProvider) → `GraphRunner`(依赖前四者) → 翻 6 消费者 → 删 GraphService + 拆测试。

> ModelResolver 必须先于 AccountGraphProvider：后者的 `accountGraph()` 用 `() => modelResolver.resolveModel()` 当 modelProvider 建图。

---

## Task 1: 抽取 graph.types.ts（公共类型）

**Files:**
- Create: `libs/agent/src/graph/graph.types.ts`
- Modify: `libs/agent/src/graph/graph.service.ts`（删类型定义，改为 import）
- Modify: `libs/agent/src/index.ts`（类型 re-export 改源）

**Interfaces:**
- Produces: `AgentConfig` / `Message` / `ThreadId` / `StreamChunk`（从 graph.types.ts 导出，定义逐字搬自 graph.service.ts 当前的同名定义，含完整 JSDoc）。

- [ ] **Step 1: 建 graph.types.ts**，把 graph.service.ts 当前的 `AgentConfig`(31-36)、`ThreadId`(38)、`Message`(40-49)、`StreamChunk`(66-105) 四个**类型/接口定义连同 JSDoc 逐字搬过来**。文件顶部需 `import { AIMessageChunk } from "@langchain/core/messages";`?—— 不需要：这四个定义不引用 AIMessageChunk。`StreamChunk` 仅用基础类型。确认无新 import 需求。

- [ ] **Step 2: graph.service.ts 改 import**：删掉这四个定义，在文件顶部加 `import type { AgentConfig, Message, StreamChunk, ThreadId } from "./graph.types";`。（`extractToolCallArgDeltas`/`resolveToolCallId`/`buildSkillsBlock` 等函数留在原处不动。）

- [ ] **Step 3: barrel 改源**。`libs/agent/src/index.ts` 第 5-10 行的
```typescript
export type { AgentConfig, Message, StreamChunk, ThreadId } from "./graph/graph.service";
```
改为
```typescript
export type { AgentConfig, Message, StreamChunk, ThreadId } from "./graph/graph.types";
```
（第 12 行 `export { GraphService }` 暂不动。）

- [ ] **Step 4: 验证**
Run: `pnpm --filter @meshbot/agent typecheck && pnpm --filter @meshbot/agent test 2>&1 | grep -E "Test Files|Tests "`
Expected: typecheck PASS；套件失败集合 == 基线（无新增）。

- [ ] **Step 5: Commit**
```bash
git add libs/agent/src/graph/graph.types.ts libs/agent/src/graph/graph.service.ts libs/agent/src/index.ts
git commit -m "refactor(agent): 抽出 graph.types（公共类型）"
```

---

## Task 2: 抽取 ModelResolver + 引入测试构造 helper

**Files:**
- Create: `libs/agent/src/graph/model-resolver.service.ts`
- Modify: `libs/agent/src/graph/graph.service.ts`（注入 ModelResolver，委派 model 相关）
- Modify: `libs/agent/src/agent.module.ts`（注册 ModelResolver）
- Modify: `libs/agent/tests/unit/graph.service.test.ts`（构造改 helper）

**Interfaces:**
- Produces: `class ModelResolver`：
  - `constructor(config: MeshbotConfigService, account: AccountContextService, overrideProvider?: ModelProvider, overrideMeta?: { providerType: string; model: string })`
  - `provider(): ModelProvider` —— 返回 `overrideProvider ?? (() => this.resolveModel())`
  - `async resolveModel(): Promise<BaseChatModel>`（move verbatim，含 set `this.modelMeta`）
  - `getMeta(): { providerType: string; model: string }` —— 返回当前 modelMeta
  - `async getTitleModel(): Promise<BaseChatModel>`（move verbatim）
  - `async summarize(serialized, opts): Promise<string>`（move verbatim；内部 `model.invoke` 用 `this.provider()()`）

- [ ] **Step 1: 建 model-resolver.service.ts**。`@Injectable()` 类。
  - 字段：`private modelMeta`、`private readonly modelCache = new Map<string, BaseChatModel>()`、`private readonly overrideProvider?`。
  - 构造：`modelMeta = overrideMeta ?? { providerType: "unknown", model: "unknown" }`；`overrideProvider` 存起来。
  - `provider()`：`return this.overrideProvider ?? (() => this.resolveModel());`
  - `getMeta()`：`return this.modelMeta;`
  - **move verbatim** graph.service.ts 的 `resolveModel`(358-373)、`getTitleModel`(383-404)、`summarize`(585-602) 三个方法体到本类（`summarize` 里 `const model = await this.modelProvider();` 改为 `const model = await this.provider()();`）。
  - import：`BaseChatModel`、`readActiveModelConfig`、`createChatModel`、`MeshbotConfigService`、`AccountContextService`、`SystemMessage`/`HumanMessage`、`ModelProvider`（from `./nodes/supervisor.node`）。

- [ ] **Step 2: GraphService 注入并委派**。
  - 构造函数**移除** `@Optional() modelProvider?` 和 `@Optional() modelMeta?` 两个参数，**新增** `private readonly modelResolver: ModelResolver`。
  - 删除字段 `modelMeta`、`modelCache`、`modelProvider`，及构造体里 `this.modelProvider = ...`/`this.modelMeta = ...` 两行。
  - `accountGraph()` 里 `this.modelProvider` → `this.modelResolver.provider()`。
  - `runGraphStream` 里读 `this.modelMeta.providerType`/`this.modelMeta.model` → `this.modelResolver.getMeta().providerType` / `.model`（共 2 处 usage 标注）。`buildContextMessage` 里 `model: ${this.modelMeta.model}` → `this.modelResolver.getMeta().model`。
  - `summarize`/`getTitleModel`/`resolveModel` 三个方法体替换为一行委派：`return this.modelResolver.summarize(...)` 等。删除 graph.service.ts 里 `resolveModel`/`getTitleModel`/`summarize` 原实现。

- [ ] **Step 3: 注册 module**。`agent.module.ts` import `ModelResolver` 并加进 `providers`（GraphService 之前）。

- [ ] **Step 4: 测试改 helper**。在 graph.service.test.ts 顶部加构造 helper（把 4 处 `new GraphService(...)` 收口到一处，后续 Task 只改这里）：
```typescript
/** 构造受测 GraphService 及其依赖的小对象图（fake model 经 ModelResolver 注入）。 */
function makeGraphService(opts: {
  configService: MeshbotConfigService;
  promptService: PromptService;
  account: AccountContextService;
  fakeModel: unknown;
  toolRegistry?: ToolRegistry;
  eventEmitter?: EventEmitter2;
  runtimeContext?: RuntimeContextPort;
  memory?: MemoryService;
  skills?: SkillService;
}): GraphService {
  const toolRegistry =
    opts.toolRegistry ??
    new ToolRegistry({ getProviders: () => [] } as never, new AccountContextService());
  const eventEmitter = opts.eventEmitter ?? new EventEmitter2();
  const modelResolver = new ModelResolver(
    opts.configService,
    opts.account,
    () => Promise.resolve(opts.fakeModel as never),
    { providerType: "fake", model: "fake-model" },
  );
  return new GraphService(
    opts.configService,
    opts.promptService,
    toolRegistry,
    eventEmitter,
    opts.account,
    modelResolver,
    opts.runtimeContext,
    opts.memory,
    opts.skills,
  );
}
```
  把 describe("GraphService") 的 beforeEach 里 `new GraphService(...)`（82-90）、以及其余 describe 里的 `new GraphService(...)`（~316、~421、~540、~621、~752 各处，按实读定位）全部改成调 `makeGraphService({...})`，**断言一字不改**。注意 import 顶部加 `ModelResolver`。

- [ ] **Step 5: 验证**
Run: `pnpm --filter @meshbot/agent typecheck && pnpm --filter @meshbot/agent test 2>&1 | grep -E "Test Files|Tests "`
Expected: typecheck PASS；失败集合 == 基线。

- [ ] **Step 6: Commit**
```bash
git add libs/agent/src/graph/model-resolver.service.ts libs/agent/src/graph/graph.service.ts libs/agent/src/agent.module.ts libs/agent/tests/unit/graph.service.test.ts
git commit -m "refactor(agent): 抽出 ModelResolver（含 summarize/getTitleModel/modelMeta）"
```

---

## Task 3: 抽取 AccountGraphProvider（共享底座）

**Files:**
- Create: `libs/agent/src/graph/account-graph.provider.ts`
- Modify: `libs/agent/src/graph/graph.service.ts`、`agent.module.ts`、`graph.service.test.ts`(helper)

**Interfaces:**
- Consumes: `ModelResolver`（Task 2）。
- Produces: `class AccountGraphProvider`：
  - `constructor(config: MeshbotConfigService, account: AccountContextService, toolRegistry: ToolRegistry, eventEmitter: EventEmitter2, modelResolver: ModelResolver)`
  - `accountGraph(): { graph; checkpointer }`（move verbatim 自 graph.service.ts:309-330，建图入参 `this.modelProvider`→`this.modelResolver.provider()`，`this.resolveMessageId`→本类的）
  - `readonly resolveMessageId: (modelId: string) => string`（move verbatim 自 215-225，连同 `msgIdMap`）
  - `deleteMsgIds(ids: Iterable<string>): void` —— 供 GraphRunner 清理 `msgIdMap`（runGraphStream 末尾 `for (const id of seenModelIds) this.msgIdMap.delete(id)` 用）

- [ ] **Step 1: 建 account-graph.provider.ts**。`@Injectable()` 类。
  - 字段 `private readonly graphsByAccount = new Map<...>()`（move verbatim 类型 186-192）、`private readonly msgIdMap = new Map<string, string>()`。
  - `resolveMessageId`（move verbatim 218-225）。
  - `accountGraph()`（move verbatim 309-330；两处替换见 Interfaces）。
  - `deleteMsgIds(ids)`：`for (const id of ids) this.msgIdMap.delete(id);`
  - import：`buildSupervisorGraph`、`createSqliteCheckpointer`、`generateSnowflakeId`、`MeshbotConfigService`、`AccountContextService`、`ToolRegistry`、`EventEmitter2`、`ModelResolver`。

- [ ] **Step 2: GraphService 注入并委派**。
  - 构造新增 `private readonly accountGraphProvider: AccountGraphProvider`；删字段 `graphsByAccount`、`msgIdMap`、`resolveMessageId`。
  - 全文件 `this.accountGraph()` → `this.accountGraphProvider.accountGraph()`（accountGraph 私有方法本身删除）。
  - `this.resolveMessageId` → `this.accountGraphProvider.resolveMessageId`（runGraphStream 内）。
  - runGraphStream 末尾 `for (const id of seenModelIds) this.msgIdMap.delete(id)` → `this.accountGraphProvider.deleteMsgIds(seenModelIds)`。

- [ ] **Step 3: 注册 module**（providers 加 AccountGraphProvider，置于 ModelResolver 后、GraphService 前）。

- [ ] **Step 4: 更新 test helper**。`makeGraphService` 里新建 `const accountGraphProvider = new AccountGraphProvider(opts.configService, opts.account, toolRegistry, eventEmitter, modelResolver);` 并加进 `new GraphService(...)` 入参对应位置。

- [ ] **Step 5: 验证**（typecheck + 套件基线，命令同上）

- [ ] **Step 6: Commit**
```bash
git commit -am "refactor(agent): 抽出 AccountGraphProvider（graphsByAccount/accountGraph/resolveMessageId 共享底座）"
```

---

## Task 4: 抽取 ContextBuilder

**Files:**
- Create: `libs/agent/src/graph/context-builder.ts`
- Modify: `graph.service.ts`、`agent.module.ts`、`graph.service.test.ts`(helper)

**Interfaces:**
- Produces: `class ContextBuilder`：
  - `constructor(account, @Optional runtimeContext?, @Optional memory?, @Optional skills?, modelResolver)` —— buildContextMessage 需 `modelMeta.model`，故注入 ModelResolver 取 `getMeta().model`。
  - `buildMemorySection(): string`（verbatim 252-258）
  - `async buildContextMessage(threadId, kind?): Promise<SystemMessage>`（verbatim 261-288；`this.modelMeta.model`→`this.modelResolver.getMeta().model`）
  - `buildSkillsMessage(): SystemMessage`（verbatim 294-300）
  - `hasSkills(): boolean` —— `return !!this.skills;`（streamMessageImpl 里 `if (this.skills)` 用）
  - 模块级 `buildSkillsBlock`（verbatim 162-181）随本文件搬来并导出。

- [ ] **Step 1: 建 context-builder.ts**。`@Injectable()`。move verbatim 上述方法 + `buildSkillsBlock` 函数。`buildSkillsMessage` 调本文件的 `buildSkillsBlock`。import：`SystemMessage`、`MEMORY_GUIDE`、`MemoryService`、`SkillService`、`AccountContextService`、`RUNTIME_CONTEXT_PORT`/`RuntimeContextPort`、`ModelResolver`、`ThreadId`(from graph.types)。`@Optional()`/`@Inject(RUNTIME_CONTEXT_PORT)` 装饰沿用 graph.service 现写法。

- [ ] **Step 2: GraphService 委派**。注入 `ContextBuilder`；删 `buildMemorySection`/`buildContextMessage`/`buildSkillsMessage` 原实现与模块级 `buildSkillsBlock`（移走）。streamMessageImpl/resumeStream 内：`this.buildMemorySection()`→`this.contextBuilder.buildMemorySection()`、`this.buildContextMessage(...)`→`this.contextBuilder.buildContextMessage(...)`、`if (this.skills)`→`if (this.contextBuilder.hasSkills())`、`this.buildSkillsMessage()`→`this.contextBuilder.buildSkillsMessage()`。GraphService 构造里 `@Optional() memory`/`@Optional() skills`/`runtimeContext` 若仅被 ContextBuilder 用则可从 GraphService 移除（按实读确认无其他引用后删）。

- [ ] **Step 3: module** 注册 ContextBuilder。

- [ ] **Step 4: test helper** 构造 `new ContextBuilder(opts.account, opts.runtimeContext, opts.memory, opts.skills, modelResolver)` 并传入 GraphService。注意 `buildContextMessage`/`buildMemorySection` 的专项 describe（589/719）现在测的是 ContextBuilder 行为——helper 暴露该 ContextBuilder 或这些 describe 直接 `new ContextBuilder(...)`（按实读把这些断言指向 ContextBuilder 实例，行为不变）。

- [ ] **Step 5: 验证**（命令同上）

- [ ] **Step 6: Commit**
```bash
git commit -am "refactor(agent): 抽出 ContextBuilder（context/skills/memory 组装）"
```

---

## Task 5: 抽取 ThreadStateService

**Files:**
- Create: `libs/agent/src/graph/thread-state.service.ts`
- Modify: `graph.service.ts`、`agent.module.ts`、`graph.service.test.ts`(helper)

**Interfaces:**
- Consumes: `AccountGraphProvider`（Task 3）。
- Produces: `class ThreadStateService`：
  - `constructor(accountGraphProvider: AccountGraphProvider)`
  - `clearThread(threadId: string): void`（verbatim 338-351；`this.accountGraph()`→`this.accountGraphProvider.accountGraph()`）
  - `async sanitizeOrphanToolCalls(threadId): Promise<void>`（verbatim 494-532）
  - `async cutMessagesAfter(threadId, cutoffMessageId): Promise<void>`（verbatim 541-563）
  - `async getMessagesSnapshot(threadId): Promise<BaseMessage[]>`（verbatim 570-576）
  - `async getHistory(threadId): Promise<Message[]>`（verbatim 904-927）
  - `async applyCompaction(threadId, params): Promise<void>`（verbatim 618-640）
  - `private roleOf(m): "user"|"assistant"|"system"`（verbatim 929-934）

- [ ] **Step 1: 建 thread-state.service.ts**。`@Injectable()`。move verbatim 上述 7 方法，所有 `this.accountGraph()` → `this.accountGraphProvider.accountGraph()`。import：`BaseMessage`/`RemoveMessage`/`SystemMessage`、`randomUUID`、`GraphState`(from graph.builder)、`Message`/`ThreadId`(graph.types)、`AccountGraphProvider`。

- [ ] **Step 2: GraphService 委派**。注入 `ThreadStateService`；`sanitizeOrphanToolCalls` 内部调用点（streamMessageImpl 451、resumeStream 657）→ `this.threadState.sanitizeOrphanToolCalls(...)`；公共方法 `clearThread`/`cutMessagesAfter`/`getMessagesSnapshot`/`getHistory`/`applyCompaction` 改一行委派；删 graph.service.ts 这些原实现 + `roleOf`。

- [ ] **Step 3: module** 注册 ThreadStateService。

- [ ] **Step 4: test helper** 构造 `new ThreadStateService(accountGraphProvider)` 传入 GraphService。`returns history after streamMessage`(152) 等 describe 现走 GraphService.getHistory 委派，断言不变。

- [ ] **Step 5: 验证**（命令同上）

- [ ] **Step 6: Commit**
```bash
git commit -am "refactor(agent): 抽出 ThreadStateService（checkpoint 状态读写/修复）"
```

---

## Task 6: 抽取 GraphRunner（流核心）—— GraphService 变纯薄壳

**Files:**
- Create: `libs/agent/src/graph/graph-runner.service.ts`
- Modify: `graph.service.ts`、`agent.module.ts`、`graph.service.test.ts`(helper)

**Interfaces:**
- Consumes: `AccountGraphProvider`/`ModelResolver`/`ContextBuilder`/`ThreadStateService`。
- Produces: `class GraphRunner`：
  - `constructor(promptService, accountGraphProvider, modelResolver, contextBuilder, threadState)`
  - `async startSession(_config): Promise<ThreadId>`（verbatim 414-417）
  - `async *streamMessage(threadId, inputs, signal?, kind?): AsyncGenerator<StreamChunk>`（verbatim 429-436，调 streamMessageImpl）
  - `private async *streamMessageImpl(...)`（verbatim 438-480；`this.promptService`、`this.contextBuilder.*`、`this.threadState.sanitizeOrphanToolCalls`、`this.accountGraphProvider.accountGraph()`）
  - `async *resumeStream(threadId, signal?, kind?): AsyncGenerator<StreamChunk>`（verbatim 652-668）
  - `private async *runGraphStream(...)`（verbatim 680-780；`this.modelResolver.getMeta()`、`this.accountGraphProvider.{accountGraph,resolveMessageId,deleteMsgIds}`）
  - 模块级 `extractToolCallArgDeltas`(108-132)、`resolveToolCallId`(142-153)、`extractUsage`(958-1056)、`resolveRecursionLimit`(1065-1071)、`interface ExtractedUsage`(938-945) 随本文件搬来（前两个**导出**，与 barrel 兼容）。

- [ ] **Step 1: 建 graph-runner.service.ts**。`@Injectable()`。move verbatim 上述 5 方法 + 4 个模块级辅助 + ExtractedUsage。替换所有 `this.*` 引用为注入依赖（见 Interfaces）。import：`BaseMessage`/`AIMessageChunk`/`HumanMessage`/`SystemMessage`/`RemoveMessage`、`randomUUID`、`PromptService`、`GraphState`/`buildSupervisorGraph`?(只需类型)、`StreamChunk`/`ThreadId`(graph.types)、四个注入服务。

- [ ] **Step 2: GraphService 委派**。注入 `GraphRunner`；`startSession`/`streamMessage`/`resumeStream` 改一行委派；删 graph.service.ts 里 streamMessageImpl/runGraphStream/extractUsage/resolveRecursionLimit/extractToolCallArgDeltas/resolveToolCallId(移走)。**此时 graph.service.ts 应只剩**：类壳 + 构造（注入 5 服务）+ 8 个一行委派方法。确认它已无独立逻辑。

- [ ] **Step 3: module** 注册 GraphRunner。

- [ ] **Step 4: test helper** 构造 `new GraphRunner(promptService, accountGraphProvider, modelResolver, contextBuilder, threadState)` 传入 GraphService。

- [ ] **Step 5: 验证**（typecheck + 套件基线）。额外确认 barrel 仍导出 `extractToolCallArgDeltas`/`resolveToolCallId` 若有外部引用——grep 确认 `tool-call-arg-deltas.test.ts` 从 `graph.service` import，**改为从 `graph-runner.service` import**（Step 5 一并改这个测试的 import 行）。

- [ ] **Step 6: Commit**
```bash
git commit -am "refactor(agent): 抽出 GraphRunner（流核心）—— GraphService 变薄 facade"
```

---

## Task 7: 翻 6 个消费者注入聚焦服务

**Files:**
- Modify: `libs/agent/src/index.ts`（barrel 导出新服务）
- Modify: 6 个消费者服务 + 它们的单测（见下表）

**Interfaces:**
- Consumes: 5 新服务（已是 DI 单例、已注册 module）。

消费者映射（注入改 + 调用点改 `this.graph.X` → `this.<svc>.X`）：

| 文件 | 注入改为 | 调用点 |
|------|---------|--------|
| `apps/server-agent/src/services/runner.service.ts` | `GraphRunner` | `streamMessage`/`resumeStream` |
| `apps/server-agent/src/services/context-compactor.service.ts` | `ThreadStateService` + `ModelResolver` | `getMessagesSnapshot`/`applyCompaction`；`summarize` |
| `apps/server-agent/src/services/session-title.service.ts` | `ModelResolver` | `getTitleModel` |
| `apps/server-agent/src/services/suggestion.service.ts` | `ModelResolver` | `getTitleModel` |
| `apps/server-agent/src/services/session.service.ts` | `ThreadStateService` | `cutMessagesAfter` |
| `apps/server-agent/src/services/checkpointer-cleanup.service.ts` | `ThreadStateService` | `clearThread` |

- [ ] **Step 1: barrel 导出新服务**。`libs/agent/src/index.ts` 加：
```typescript
export { GraphRunner } from "./graph/graph-runner.service";
export { ModelResolver } from "./graph/model-resolver.service";
export { ThreadStateService } from "./graph/thread-state.service";
```
（`GraphService` export 第 12 行暂留，Task 8 删。）

- [ ] **Step 2: 逐个改消费者**。每个文件：import 改名、构造参数类型改、`this.graph.X(...)` → `this.<svc>.X(...)`。逐个改、逐个 typecheck（`pnpm --filter @meshbot/server-agent typecheck`）。

- [ ] **Step 3: 改消费者单测**。每个消费者的 `*.spec.ts`/`*.test.ts`：构造/mock 从 GraphService 改为对应聚焦服务，断言委派到正确服务。按各测试实读对齐。

- [ ] **Step 4: 验证**
Run: `pnpm --filter @meshbot/server-agent typecheck && pnpm --filter @meshbot/agent typecheck && pnpm check`
Run: 跑 server-agent 受影响测试 + agent 套件，确认失败集合 == 基线。

- [ ] **Step 5: Commit**
```bash
git commit -am "refactor(server-agent): 6 消费者直接注入聚焦服务（GraphRunner/ModelResolver/ThreadStateService）"
```

---

## Task 8: 删除 GraphService + 拆测试 + 收尾

**Files:**
- Delete: `libs/agent/src/graph/graph.service.ts`
- Delete/Split: `libs/agent/tests/unit/graph.service.test.ts` → 新建 `graph-runner.test.ts` / `context-builder.test.ts` / `thread-state.test.ts` / `model-resolver.test.ts`
- Modify: `libs/agent/src/agent.module.ts`、`libs/agent/src/index.ts`

- [ ] **Step 1: 删 GraphService**。确认无引用：`grep -rn "GraphService" apps libs --include="*.ts" | grep -v dist`（应只剩将删的 test/barrel/module）。删 graph.service.ts。`agent.module.ts` 移除 GraphService import + provider + export。`index.ts` 移除第 12 行 `export { GraphService }`。

- [ ] **Step 2: 拆测试**。把 graph.service.test.ts 的断言按服务边界搬到新文件，**断言逐字不变**，构造改成直接 `new <Service>(...)`（沿用 Task 2-6 helper 里的小对象图构造方式）：
  - streamMessage/resumeStream/startSession/usage/messageId 收口/system:ctx 不累积 → `graph-runner.test.ts`
  - buildContextMessage/buildMemorySection/系统提示注入 → `context-builder.test.ts`
  - getHistory → `thread-state.test.ts`
  - （3 个基线红用例随 streamMessage/resumeStream 进 graph-runner.test.ts，**保持同样的红**）
  删除 graph.service.test.ts。

- [ ] **Step 3: 全量验证**
Run: `pnpm --filter @meshbot/agent typecheck && pnpm --filter @meshbot/server-agent typecheck && pnpm --filter @meshbot/agent test 2>&1 | grep -E "Test Files|Tests " && pnpm check`
Expected: typecheck 全 PASS；agent 套件失败集合 == 基线 9（位置变到新文件，数量/性质不变）；`pnpm check` 全绿。

- [ ] **Step 4: 行数核对**（佐证拆分达成）
Run: `wc -l libs/agent/src/graph/*.ts`
Expected: 无单文件 > ~400 行；graph.service.ts 不存在。

- [ ] **Step 5: Commit**
```bash
git commit -am "refactor(agent): 删除 GraphService 薄壳，graph.service.test 按服务拆分"
```

---

## Self-Review（计划自检）

**Spec 覆盖：** 5 单元 + graph.types → Task 1-6 ✓；直接注入 6 消费者 → Task 7 ✓；删 GraphService + 拆测试 → Task 8 ✓；modelMeta 显式 getMeta → Task 2 ✓；resolveMessageId 单实例归 AccountGraphProvider → Task 3 ✓；summarize 归 ModelResolver → Task 2 ✓；context-builder 独立 → Task 4 ✓；迁移期 facade 每步绿 → 每 Task 验证 ✓；barrel 兼容 → Task 1/6/7/8 ✓；基线红保持 → Global Constraints + Task 8 ✓。

**占位符扫描：** 无 TBD。方法体「move verbatim from graph.service.ts:行号」是重构的正确粒度（逐字搬移、非重写），不是占位符；新骨架/接线/委派/测试 helper 均给完整代码。

**类型一致性：** `ModelResolver.{provider,resolveModel,getMeta,getTitleModel,summarize}` / `AccountGraphProvider.{accountGraph,resolveMessageId,deleteMsgIds}` / `ContextBuilder.{buildContextMessage,buildMemorySection,buildSkillsMessage,hasSkills}` / `ThreadStateService.{clearThread,sanitizeOrphanToolCalls,cutMessagesAfter,getMessagesSnapshot,getHistory,applyCompaction}` / `GraphRunner.{startSession,streamMessage,resumeStream}` 在定义 Task 与消费 Task 间签名一致。

**实现期校验点（非阻塞，typecheck/grep 即时暴露）：** ① graph.service.test.ts 各 `new GraphService` 行号会随前序 Task 漂移——按实读定位，别认死行号；② ContextBuilder 是否真的吃掉 GraphService 的 `@Optional memory/skills/runtimeContext`——Task 4 grep 确认无其他引用再删；③ 消费者单测的 mock 形态各异（Task 7 按实读对齐）；④ `tool-call-arg-deltas.test.ts` 的 import 源在 Task 6 改。
