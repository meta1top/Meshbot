# 实施计划：agent 分层记忆 + 运行时上下文（system:ctx）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 executing-plans。Steps 用 `- [ ]`。

**Goal:** ①补运行时上下文消息 `system:ctx`（每 run 刷新、LLM 可见、稳定 id）；②给 agent 加分层自管理文件记忆（core 注系统提示 + archival `memory_search`）；全程账号隔离、工具不让 agent 传 cloudUserId。

**关联：** [设计](../specs/2026-06-23-agent-memory-and-runtime-context-design.md)

## Global Constraints
- 账号化路径一律经 `MeshbotConfigService` getter（ALS 当前账号）；工具 schema 禁含 cloudUserId/account 入参。
- 中文 JSDoc（公开方法）；中文 conventional commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；别 --no-verify。
- libs/agent 用 vitest（dist 含 spec 的污染：跑单文件 `vitest run <file>` 规避）；server-agent 用 jest。
- 每 task：相关包测试绿 + biome；全部完成 `pnpm typecheck` + `pnpm check` 全绿。
- `system:ctx` 不放 `now`（实时时间走 date 工具，用 ctx.timezone 解释）。

---

## Phase 1：system:ctx 运行时上下文基建

### Task 1: RUNTIME_CONTEXT_PORT + buildContextMessage

**Files:** Create `libs/agent/src/graph/runtime-context.port.ts`；Modify `libs/agent/src/graph/graph.service.ts`；Test `libs/agent/tests/unit/graph.service.test.ts`（追加）。

**Interfaces — Produces:**
```ts
// runtime-context.port.ts —— libs/agent→server-agent 解耦（displayName/language/timezone 来自身份/设置）
export const RUNTIME_CONTEXT_PORT = Symbol("RUNTIME_CONTEXT_PORT");
export interface RuntimeContextPort {
  /** 在账号上下文内解析当前账号运行时信息；字段缺失返 null。 */
  resolve(): Promise<{
    displayName: string | null;
    language: string | null;
    timezone: string | null;
  }>;
}
```

- [ ] **Step 1:** 写 `runtime-context.port.ts`（上方全文 + 中文 JSDoc）。
- [ ] **Step 2:** `graph.service.ts` 构造区注入 `@Optional() @Inject(RUNTIME_CONTEXT_PORT) private readonly runtimeContext?: RuntimeContextPort`（`@Optional`：libs/agent 独立测试 / 无绑定时降级）。加私有方法：
```ts
/** 组装运行时上下文消息（稳定 id system:ctx；每 run 刷新；不含易变 now）。 */
private async buildContextMessage(threadId: ThreadId): Promise<SystemMessage> {
  const cloudUserId = this.account.getOrThrow();
  const ext = this.runtimeContext ? await this.runtimeContext.resolve() : null;
  const tz = ext?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = [
    `cloudUserId: ${cloudUserId}`,
    `sessionId: ${threadId}`,
    ...(ext?.displayName ? [`user: ${ext.displayName}`] : []),
    `model: ${this.modelMeta.model}`,
    ...(ext?.language ? [`language: ${ext.language}`] : []),
    `timezone: ${tz}`,
  ];
  return new SystemMessage({
    id: "system:ctx",
    content: `<context>\n${lines.join("\n")}\n</context>`,
  });
}
```
- [ ] **Step 3:** 测试（vitest，追加；用既有 harness 构造 GraphService）：fake `RuntimeContextPort.resolve()` 返 `{displayName:"Grant", language:"zh", timezone:"Asia/Shanghai"}`，断言 `buildContextMessage("s1")` 的 `id==="system:ctx"`、content 含 `cloudUserId:`/`sessionId: s1`/`user: Grant`/`timezone: Asia/Shanghai`、**不含 `now`/当前日期**。无 port 时 timezone 兜底为 Intl 解析值。
> 注：buildContextMessage 私有，测试可经 `(gs as any).buildContextMessage` 或抽到可测边界（按既有 spec 风格择一）。
- [ ] **Step 4:** `pnpm --filter @meshbot/agent exec vitest run tests/unit/graph.service.test.ts` 绿；typecheck；biome；提交。

### Task 2: 每 run 刷新注入 system:ctx（streamMessage + resumeStream）

**Files:** Modify `libs/agent/src/graph/graph.service.ts`；Test 同上。

**Interfaces — Consumes:** Task 1 `buildContextMessage`；`RemoveMessage`（已 import）。

- [ ] **Step 1:** 写失败测试：连续两次 `streamMessage` 后，`getState().values.messages` 里 **id==="system:ctx" 的消息恰好 1 条**（刷新不累积），且为最新值。fake graph harness（用 TwoRoundModel 或既有 fakeModel；断言 state 而非事件）。
- [ ] **Step 2:** `streamMessageImpl`：在 systemPrompt 注入之后、human 之前插入刷新对：
```ts
if (systemPrompt && !hasHistory) inputMessages.push(new SystemMessage(systemPrompt));
inputMessages.push(new RemoveMessage({ id: "system:ctx" })); // 删旧（首 run 无则 no-op）
inputMessages.push(await this.buildContextMessage(threadId)); // 加新
for (const input of inputs) inputMessages.push(new HumanMessage({ content: input.content, id: input.id }));
```
`resumeStream`（[graph.service runGraphStream({messages:[]})]）改为：
```ts
yield* this.runGraphStream(threadId, {
  messages: [new RemoveMessage({ id: "system:ctx" }), await this.buildContextMessage(threadId)],
}, signal);
```
- [ ] **Step 3:** 测试转绿（state 内只 1 条 system:ctx）；既有 graph.service 用例不回归（注意：消息序列里多了 system:ctx，若有断言消息条数的用例需同步）。
- [ ] **Step 4: 跨 provider 冒烟验证（设计风险）** —— 非首位 SystemMessage 兼容性。在本地对启用的 provider（deepseek / anthropic / openai 兼容 / google 任一可达者）跑一次真实 streamMessage，确认非首位 system:ctx 能下发、不报错、不被吞。若某 provider 报错 → 落兜底：**增强 `graph.builder` reducer 让同 id 消息原地替换**（保持 ctx 紧随主系统提示之后、不漂到末尾），或改用带前缀的 `HumanMessage` 承载 ctx。把结论写进提交说明。
- [ ] **Step 5:** typecheck + 测试 + biome + 提交。

### Task 3: server-agent 绑定 RUNTIME_CONTEXT_PORT（@Global）

**Files:** Modify 合适 module（建议 `apps/server-agent/src/agent-runtime` 相关或新建轻量 `runtime-context.module.ts`，`@Global`）；Test 可选（boot 解析）。

**Interfaces — Consumes:** `RUNTIME_CONTEXT_PORT`（@meshbot/agent）。

- [ ] **Step 1:** 新建 `@Global` module（仿 CronJobModule），`useFactory` 提供 `RUNTIME_CONTEXT_PORT`：`resolve()` 从现有服务取 —— **displayName**：CloudIdentityService（当前账号身份显示名，先读它有无 displayName，无则 null）；**language**：SettingService（界面语言设置，无则 null）；**timezone**：SettingService（用户时区设置，无则 null → graph.service 兜底 Intl）。**先读这些 service 的真实 API 再接线**（`apps/server-agent/src/services/cloud-identity.service.ts` / `setting.service.ts`）。在 `app.module` imports 注册。
- [ ] **Step 2:** typecheck `@meshbot/server-agent`；确认 app boot DI 能解析（GraphService 的 @Optional 端口此时有绑定）。`pnpm check` + biome + 提交。

### Task 4: 修正 bash 工具陈旧描述

**Files:** Modify `libs/agent/src/tools/builtins/bash.tool.ts`。

- [ ] **Step 1:** 描述里「cwd is locked to ~/.meshbot/workspace」改为准确措辞，如 "Runs in your current account's workspace directory (cwd = the account workspace); paths are account-scoped automatically."（不泄露绝对路径）。cwd 实现已是 `getWorkspaceDir()`，不动逻辑。
- [ ] **Step 2:** typecheck + biome + 提交。

---

## Phase 2：agent 分层自管理记忆

### Task 5: getMemoryDir + MemoryService

**Files:** Modify `libs/agent/src/config/meshbot-config.service.ts`（加 `getMemoryDir`）；Create `libs/agent/src/memory/memory.service.ts` + `memory.types.ts` + `.spec.ts`。

**Interfaces — Produces:**
```ts
// memory.types.ts
export interface MemoryEntry { id: string; title: string; tags: string[]; createdAt: string; content: string; }
// memory.service.ts（注入 MeshbotConfigService；账号化经 getMemoryDir）
class MemoryService {
  readCore(): string;                                   // core.md 内容（无则 ""）
  writeCore(content: string): void;                     // 超 CORE_MAX_BYTES 抛 AppError
  add(input: { content: string; title?: string; tags?: string[] }): MemoryEntry; // 雪花 id，写 archive/<id>.md
  search(query?: string, limit?: number): MemoryEntry[];// 关键词(title/tags/content) + createdAt desc；空 query=最近 limit
  delete(id: string): void;                             // 幂等
}
```

- [ ] **Step 1:** `meshbot-config.service.ts` 加：
```ts
/** 记忆目录：<meshbotDir>/accounts/<account>/memory（按账号隔离）。 */
getMemoryDir(): string { return path.join(this.accountDir(), "memory"); }
```
- [ ] **Step 2:** 写 `.spec.ts`（vitest，仿 skill.service 测试 + 账号上下文 harness）：
  - core：writeCore→readCore 往返；超 `CORE_MAX_BYTES`（如 2048）抛错。
  - add：返回带雪花 id 的 entry，archive/<id>.md 落盘含 frontmatter（id/title/tags/createdAt）+ 正文。
  - search：按关键词命中 title/tags/content；空 query 返最近 N 条（createdAt desc）；limit 生效。
  - delete：删后 search 不含；删不存在幂等。
  - 账号隔离：不同 account 上下文写入互不可见（仿 skill 账号隔离测试）。
- [ ] **Step 3:** 实现 `memory.service.ts`：`@Injectable`，注入 `MeshbotConfigService`；雪花用 `generateSnowflakeId`（@meshbot/common，libs/agent 已依赖）；frontmatter 解析/生成仿 skill.service 的 `FRONTMATTER_RE`；core 写入前按字节数校验（`Buffer.byteLength`）。文件名/ id 防穿越（雪花纯数字，安全）。
- [ ] **Step 4:** `vitest run libs/agent/src/memory/memory.service.spec.ts` 绿；typecheck；biome；提交。

### Task 6: 4 个 memory 工具 + agent.module 注册

**Files:** Create `libs/agent/src/tools/builtins/memory-core-write.tool.ts` / `memory-add.tool.ts` / `memory-search.tool.ts` / `memory-delete.tool.ts`（+ `.spec.ts`）；Modify `libs/agent/src/agent.module.ts`。

**Interfaces — Consumes:** MemoryService（直接注入，无端口 —— 纯本地）。

- [ ] **Step 1:** 写 4 工具（`@Injectable @Tool`，implements `MeshbotTool<Args,string>`，注入 `MemoryService`，中/英 description 说明用途，execute 委托 + 结果串）：
  - `memory_core_write`：args `{ content }` → `memory.writeCore` → `"Core memory updated."`（超限抛错信息返回）。
  - `memory_add`：args `{ content, title?, tags? }` → `memory.add` → `JSON.stringify(entry)`。
  - `memory_search`：args `{ query?, limit? }` → `memory.search` → `JSON.stringify(list)`。
  - `memory_delete`：args `{ id }` → `memory.delete` → `"Deleted <id>."`。
- [ ] **Step 2:** `agent.module.ts`：import + providers 加 MemoryService + 4 工具（仿 SkillService/SkillListTool 位置）。
- [ ] **Step 3:** 4 个 `.spec.ts`：假 MemoryService，断言 schema 解析 + 调 service + 返回串（仿 skill-tools.spec）。`vitest run` 绿。
- [ ] **Step 4:** typecheck + biome + 提交。

### Task 7: core 记忆注入系统提示

**Files:** Modify `libs/agent/src/graph/graph.service.ts`（系统提示组装处）；可选 Create 内置「记忆使用说明」常量文件 `libs/agent/src/memory/memory-guide.ts`；Test 同 graph.service。

**Interfaces — Consumes:** MemoryService（GraphService 注入）。

- [ ] **Step 1:** 写失败测试：当 core.md 非空时，首轮注入的系统提示文本含 `<memory>` 段 + core 内容 + 记忆使用说明关键句；core 为空时仍注入说明（或省略 `<memory>`，二选一在实现固定并断言）。
- [ ] **Step 2:** GraphService 注入 MemoryService；系统提示组装改为：`const systemPrompt = [persona, buildMemorySection()].filter(Boolean).join("\n\n")`，其中 `buildMemorySection()` = 内置 `MEMORY_GUIDE`（何时 memory_add / 更新 core / memory_search，避免记噪声）+ `<memory>\n${memory.readCore()}\n</memory>`（core 空则仅说明或省略）。保持「仅首轮注入」机制不变。
- [ ] **Step 3:** 测试绿；既有系统提示相关用例不回归；typecheck + biome + 提交。

---

## 收尾验证
- [ ] `pnpm typecheck` 26/26；`pnpm check` 全绿。
- [ ] 关键测试：graph.service（buildContextMessage + 刷新不累积 + core 注入）、memory.service、4 memory 工具、bash 描述。
- [ ] 集成冒烟：跑一轮对话，确认上下文里有 1 条 system:ctx（含 cloudUserId/sessionId/displayName/model/language/timezone、无 now）；让 agent 记一条事实（memory_add）→ 新会话能 memory_search 命中；core 写入后下次会话系统提示含该 core；切账号后记忆/ctx 身份互相隔离。

## Self-Review
- **Spec 覆盖**：A(system:ctx)=Task1-3；bash 不变量修正=Task4；B(记忆)=Task5-7（getMemoryDir+Service / 工具 / core 注入）；archival 检索=Task5 search；账号隔离=getMemoryDir + ALS（贯穿）。
- **占位符**：端口/buildContextMessage/getMemoryDir/MemoryService 签名 + 工具行为给全；displayName/language/timezone 的 server-agent 来源标「实现期读真实 service API 接线」（Task3，属脚手架接线非逻辑占位）；buildMemorySection 文案 = 内置 guide（Task7 定稿）。
- **类型一致**：RuntimeContextPort.resolve 形状 Task1↔Task3 一致；MemoryEntry 在 service↔工具一致；system:ctx id 字面量 "system:ctx" 在注入与删除一致。
- **风险**：非首位 system:ctx 跨 provider（Task2 Step4 验证 + 兜底）；libs/agent vitest dist 污染（跑单文件规避）；server-agent @Global 端口绑定后 app boot DI（Task3 验证，仿既有 @Global 端口）。
