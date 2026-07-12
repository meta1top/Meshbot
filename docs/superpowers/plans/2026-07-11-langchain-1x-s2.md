# langchain 1.x S2（现代化 + 全面还债）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清完 S1 留下的 deprecated 用法与全部测试债务：lib-agent vitest 9→0、server-agent jest 5 个 import 崩 suite→0，运行时行为零变化。

**Architecture:** 七个独立工作项（A-G），每项一个 commit，任何一项翻车可单独 revert。先做零风险的工作流根治（E/F/G），再做运行时改动（A/B），最后测试重写（C/D）——这样 C/D 跑测试时已经不需要 rm dist 舞步。

**Tech Stack:** LangGraph 1.4.7 Annotation API / checkpoint-sqlite 1.0.3 deleteThread / vitest 4 / ts-jest / core 1.2.2 流式协议

## Global Constraints

- 分支 `feat/langchain-1x` 主仓直接工作（无 worktree），连续提交不切 PR。
- **运行时行为零变化**：A/B 是仅有的运行时改动，验收含 S1 探针复跑 + 快速眼验。
- reasoning 链路（`additional_kwargs.reasoning_content` 的读写点）**一律不碰**——S3 范围。
- server-main / `PROVIDERS` 常量 / web 前端零改动（G 只动根 jest.config 与 test/mocks）。
- 禁 `as any` / `@ts-ignore` 消音；测试修复以「红因可解释」为底线，不许弱化断言凑绿。
- 每完成一项：`pnpm check:format`，再跑该项的验收命令，然后独立 commit（中文 conventional）。
- **测试运行姿势**（E/F 完成前仍需）：vitest 前 `rm -rf libs/agent/dist`；build 前
  `rm -f libs/agent/tsconfig.tsbuildinfo`。E/F 完成后这两步永久作废。

## 关键实验事实（写计划前已在 1.x 实测，implementer 直接引用）

1. **官方 `FakeStreamingChatModel` 不可用**：构造时传入自定义 `chunks`，stream 出来的
   chunk 丢 `id`、丢 `usage_metadata`（实测 ids 为空、usage=null）。C 项必须用手写 fake。
2. **手写 fake 的 1.x 正确姿势**：继承 `BaseChatModel`，`_streamResponseChunks` yield
   `ChatGenerationChunk({ message: AIMessageChunk({id, content, usage_metadata, additional_kwargs}), text })`
   ——id / usage / additional_kwargs **全部透传**（直接 stream 与 langgraph messages 通道均实测保留）。
3. **绝不手动调 `runManager?.handleLLMNewToken(...)`**：1.x 基类自动把 yield 的 chunk 送进
   事件通道；手动再调会让 langgraph 额外合成一帧 **run-<runId> id** 的 chunk（实测 n=3、
   双 id）——这正是旧 mock 让「收口为雪花」断言 size=2 的机制。删调用即修。
4. **langgraph 1.x 可能聚合相邻同 id 帧**：两个 yield 实测只到 1 帧 messages（content 已
   拼接、usage 在帧上）。断言校准为「delta 拼接后完整」「id 集合正确」，不断言帧数。
5. `checkpointer-cleanup.service.deleteThread` 已是 async——B 项它只需加 `await`。
6. `socket.io-client` 在 server-agent 仅 `import { type Socket, io }` 一处
   （`cloud/im-relay-client.service.ts:22`）。

---

## Task E+F+G: 工作流根治三连（零运行时风险，先做）

**Files:**
- Modify: `libs/agent/vitest.config.ts`
- Modify: `libs/agent/tsconfig.json`
- Create: `test/mocks/socket-io-client.js`
- Modify: `jest.config.ts`（根）

**Interfaces:**
- Consumes: 无
- Produces: 后续所有 Task 的测试运行不再需要 rm dist / rm tsbuildinfo 舞步；
  server-agent jest 5 个 import 崩 suite 恢复执行。

- [ ] **Step 1: vitest 排除 dist（E）**

`libs/agent/vitest.config.ts` 整文件改为：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // 排除 tsc 编译产物：dist 里的 *.spec.js 是 CJS，require("vitest") 必崩，
    // 会制造约 20 个假 file 失败（曾迫使「跑 vitest 前必须 rm -rf dist」的舞步）。
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
```

- [ ] **Step 2: tsBuildInfoFile 落进 dist（F）**

`libs/agent/tsconfig.json` 的 `compilerOptions` 增加一行（保持其余不动）：

```json
    "tsBuildInfoFile": "./dist/tsconfig.tsbuildinfo",
```

> 原缓存在包根，`rm -rf dist` 后 tsc 判定 up-to-date 空 emit，下游报「缺导出/
> implicit any/找不到模块」幽灵错误（S1 期间咬了四次）。落进 dist 后随删随失效。

顺手检查同病：`grep -L tsBuildInfoFile libs/*/tsconfig.json` 里凡 `incremental` 或
`composite` 为 true 且 outDir=dist 的包一并加同款行；无 incremental 的不动。

- [ ] **Step 3: 删掉包根的陈旧缓存并验证 F**

```bash
rm -f libs/agent/tsconfig.tsbuildinfo
rm -rf libs/agent/dist
pnpm --filter @meshbot/lib-agent build
ls libs/agent/dist/index.d.ts libs/agent/dist/tsconfig.tsbuildinfo
```

预期：两个文件都在（emit 完整 + 缓存进了 dist）。再连跑一次 build 验证增量模式无异常。

- [ ] **Step 4: socket.io-client CJS stub（G）**

Create `test/mocks/socket-io-client.js`：

```js
/**
 * socket.io-client 的 jest CJS stub。
 *
 * 真包是 ESM-only（export map 无 CJS 入口），ts-jest（CommonJS）解析必崩
 * `Cannot find module 'socket.io-client'`，拖垮 server-agent 5 个 suite 的
 * import 链（remote-device-query + 4 个 e2e）。同 @vscode/ripgrep stub 先例。
 *
 * 只需满足被 import 的符号：`{ type Socket, io }`（im-relay-client.service.ts）。
 * Socket 是纯类型不需要运行时值；io() 返回一个惰性 no-op socket——相关 suite
 * 均 mock 掉上层 service，不会真正驱动 socket 行为。
 */
const noopSocket = {
  on: () => noopSocket,
  once: () => noopSocket,
  off: () => noopSocket,
  emit: () => noopSocket,
  connect: () => noopSocket,
  disconnect: () => noopSocket,
  close: () => noopSocket,
  removeAllListeners: () => noopSocket,
  connected: false,
};
module.exports = { io: () => noopSocket };
```

根 `jest.config.ts` 的 `moduleNameMapper` 里、`@vscode/ripgrep` 那条旁边加：

```ts
    // socket.io-client 是 ESM-only：CJS jest 解析不了 export map。stub 满足
    // im-relay-client 的 `import { io }`；相关 suite 都 mock 上层 service。
    "^socket\\.io-client$": "<rootDir>/test/mocks/socket-io-client.js",
```

- [ ] **Step 5: 验证 G 并全量确认**

```bash
npx jest apps/server-agent libs/common 2>&1 | tail -4
```

预期：**Test Suites 全 passed（此前 5 个 import 崩的 suite 恢复）**，0 failed。
若某 e2e suite 恢复执行后暴露出新的断言失败（此前从没真正跑过），逐个看红因：
是 stub 塑形不足 → 按其断言最小扩 stub；是测试本身的债 → 记录进 commit message，
**不在本 Task 修**（那是独立的预存在测试债，超出 G 的「解 import 崩」范围）。

```bash
rm -rf libs/agent/dist && pnpm --filter @meshbot/lib-agent test 2>&1 | grep -E "Test Files|Tests "
```

预期：不再出现 dist/*.spec.js 假失败；真实失败仍是基线 9 条（C/D 还没做）。

- [ ] **Step 6: 提交**

```bash
pnpm check:format && pnpm typecheck
git add libs/agent/vitest.config.ts libs/agent/tsconfig.json test/mocks/socket-io-client.js jest.config.ts
git commit -m "chore(test): 三项工作流根治——vitest 排除 dist、tsbuildinfo 落 dist、socket.io-client jest stub

- vitest exclude dist/**：根治「跑 vitest 必须先 rm dist」（dist 编译 spec 的
  CJS require(vitest) 制造 ~20 个假 file 失败）
- tsBuildInfoFile 落 dist：根治「rm dist 后 build 空 emit」（S1 期间咬四次）
- socket.io-client CJS stub：ESM-only 包解不开 export map，server-agent 5 个
  suite import 崩恢复执行（同 @vscode/ripgrep 先例）"
```

---

## Task A: State 迁移 `{channels}` → `Annotation.Root`

**Files:**
- Modify: `libs/agent/src/graph/graph.builder.ts`
- Modify（仅类型引用，按 typecheck 实际输出）: `libs/agent/src/graph/thread-state.service.ts`、
  `libs/agent/src/graph/graph-runner.service.ts`、`libs/agent/src/graph/nodes/tools.node.ts`

**Interfaces:**
- Consumes: `mergeMessages`（本文件，逻辑一行不动）
- Produces: `GraphAnnotation`（`Annotation.Root` 实例）与 `GraphState`
  （`typeof GraphAnnotation.State`）。`buildSupervisorGraph` 签名与返回不变——
  全仓唯一的 `new StateGraph` 调用点就在本函数（已 grep 证实），无其他图要迁。

- [ ] **Step 1: 迁移 graph.builder**

`graph.builder.ts` 中：

```ts
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

/** 主图 state：messages 经 mergeMessages 归并（append + 同 id 替换 + remove 删除）。 */
export const GraphAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: mergeMessages,
    default: () => [],
  }),
});

/** 图 state 类型：从 Annotation 派生，替代手写 interface。 */
export type GraphState = typeof GraphAnnotation.State;
```

删除原 `interface GraphState { messages: BaseMessage[] }`（`:13-15` 附近），构图处改为：

```ts
  return new StateGraph(GraphAnnotation)
    .addNode("supervisor", supervisor)
    .addNode("tools", tools)
    .addEdge(START, "supervisor")
    .addConditionalEdges("supervisor", routeAfterSupervisor)
    .addEdge("tools", "supervisor")
    .compile({ checkpointer });
```

- [ ] **Step 2: typecheck 收敛类型引用**

```bash
pnpm --filter @meshbot/lib-agent typecheck 2>&1 | grep "error TS" | head -20
```

对每个报错做**最小类型修复**（`GraphState` 现在是 `{ messages: BaseMessage[] }` 的
派生型，理论上兼容；supervisor.node 的 `SupervisorState` 若是独立 interface 且结构
相同则不必动）。禁 as any。改完全仓 `pnpm typecheck` 27/27。

- [ ] **Step 3: 行为回归（reducer 与图拓扑没变的证据）**

```bash
pnpm --filter @meshbot/lib-agent test 2>&1 | grep -E "Test Files|Tests "
```

预期：失败集合不变（仍是 C/D 未做的那批）；`messages-reducer.test.ts` 与
`graph.builder.test.ts` 必须绿——它们直测 mergeMessages 与图构建。

- [ ] **Step 4: 提交**

```bash
pnpm check:format && pnpm typecheck
git add -A && git commit -m "refactor(agent): StateGraph 迁 Annotation.Root，弃用 deprecated {channels} 重载

mergeMessages reducer 与图拓扑零改动；GraphState 改由 typeof GraphAnnotation.State
派生。langgraph 1.x 的 {channels} 构造重载已标 @deprecated（S1 靠它过渡）。"
```

---

## Task B: `clearThread` 迁官方 `deleteThread()`

**Files:**
- Modify: `libs/agent/src/graph/thread-state.service.ts:20-45`（clearThread 一个方法）
- Modify: `apps/server-agent/src/services/checkpointer-cleanup.service.ts:20`

**Interfaces:**
- Consumes: `SqliteSaver.deleteThread(threadId: string): Promise<void>`（1.0.3 官方，
  d.ts 已核）
- Produces: `ThreadStateService.clearThread(threadId): Promise<void>`（原 sync void →
  async；唯一消费方 checkpointer-cleanup 的 deleteThread 本就是 async，只加 await）

- [ ] **Step 1: 改 clearThread**

`thread-state.service.ts` 的 `clearThread` 整个方法替换为：

```ts
  /**
   * 删除某 thread（=sessionId）在当前账号 checkpoint 库的全部 checkpoints/writes。
   * 走 checkpoint-sqlite 1.x 官方 deleteThread（同一 better-sqlite3 连接，不再
   * 直接拼 SQL 删表——0.x 时代无官方 API 的权宜已废）。幂等：无匹配行不报错。
   * 须在账号上下文内调用。
   */
  async clearThread(threadId: string): Promise<void> {
    await this.accountGraphProvider
      .accountGraph()
      .checkpointer.deleteThread(threadId);
  }
```

- [ ] **Step 2: 消费方加 await**

`checkpointer-cleanup.service.ts:20`：

```ts
    await this.threadState.clearThread(threadId);
```

- [ ] **Step 3: 验证幂等（表未建/无匹配行不炸）**

官方 deleteThread 对未建表的行为未知——**必须实测**：

```bash
node -e "
const { createSqliteCheckpointer } = require('./libs/agent/dist/checkpoint/sqlite-checkpointer.js');
(async () => {
  const c = createSqliteCheckpointer('/tmp/s2-fresh.db');   // 全新库，表未建
  await c.deleteThread('nonexistent');                       // 不应抛
  console.log('空库 deleteThread OK');
})().catch(e => { console.log('抛了:', e.message); process.exit(1); })"
```

若抛「no such table」→ clearThread 里保留原来的 try/catch no-such-table 吞错语义
（包在 deleteThread 外面），commit message 注明。

- [ ] **Step 4: 回归 + 提交**

```bash
pnpm typecheck && npx jest apps/server-agent/src/services 2>&1 | tail -3
pnpm check:format
git add -A && git commit -m "refactor(agent): clearThread 迁 checkpoint-sqlite 1.x 官方 deleteThread

弃 checkpointer.db 直接拼 SQL 删 checkpoints/writes（0.x 无官方 API 的权宜）。
签名 sync→async，唯一消费方 checkpointer-cleanup 加 await。运行时语义等价。"
```

---

## Task C: graph 类 mock 重写（1.x 流式协议）

**Files:**
- Modify: `libs/agent/tests/unit/graph-runner.test.ts`
- Modify: `libs/agent/tests/unit/supervisor.node.test.ts`
- Modify（同病同修）: `libs/agent/src/graph/nodes/supervisor.node.spec.ts`

**Interfaces:**
- Consumes: 「关键实验事实」1-4（页首）。
- Produces: lib-agent vitest 的 graph 类 5 条失败清零（供 Task D 后合计全绿）。

- [ ] **Step 1: 重写 graph-runner.test 的 fake model**

对文件里每个手写 mock BaseChatModel 子类（`:234/365/486` 附近动态 import 构造的）：

1. **删掉全部 `await runManager?.handleLLMNewToken(...)` 调用**（实验事实 3：1.x 基类
   自动送事件通道，手动调用制造 run-id 合成帧——旧失败的机制根源）。
2. 保留 `yield new ChatGenerationChunk({ message: new AIMessageChunk({...}), text })`
   结构；chunk 上的 `id` / `usage_metadata` / `additional_kwargs.reasoning_content` /
   `tool_call_chunks` 都会透传（实验事实 2）。
3. 断言校准（实验事实 4）：帧数断言（`chunks.length` 与具体次数比较）改为
   「`chunks.map(c=>c.delta).join("")` 等于完整文本」+「messageId 全等且非模型 UUID」；
   usage 断言不变（末帧 usage 会到）。

- [ ] **Step 2: 跑 graph-runner.test 到绿**

```bash
cd libs/agent && npx vitest run tests/unit/graph-runner.test.ts 2>&1 | grep -E "Test Files|Tests |FAIL"
```

全绿后再动下一个文件。红因解释不了就停——不许弱化断言。

- [ ] **Step 3: supervisor.node.test 同修**

除 fake model 重写外，此文件还有 `resolveMessageId is not a function`（mock hoisting）：
看测试头部的 vi.mock/工厂顺序，把 `resolveMessageId` 以真实函数注入 createSupervisorNode
第三参（它就是个 `(id)=>id` 风格回调，不需要 vi.mock——直接传即可）。

```bash
npx vitest run tests/unit/supervisor.node.test.ts src/graph/nodes/supervisor.node.spec.ts 2>&1 | grep -E "Test Files|Tests "
```

- [ ] **Step 4: 提交**

```bash
pnpm check:format
git add -A && git commit -m "test(agent): graph 类 mock 重写为 1.x 流式协议，清 5 条 vitest 债

- 删手动 handleLLMNewToken：1.x 基类自动走事件通道，手动调用制造 run-id
  合成帧（收口断言 size=2 的机制根源）
- fake 只 yield ChatGenerationChunk：id/usage/reasoning/tool_call_chunks 全透传
  （官方 FakeStreamingChatModel 丢 id+usage，实测不可用）
- 帧数断言改内容断言：langgraph 1.x 会聚合相邻同 id 帧"
```

---

## Task D: agent.module DI 测试清零

**Files:**
- Modify: `libs/agent/tests/integration/agent.module.test.ts`

**Interfaces:**
- Consumes: AgentModule 依赖的宿主 port symbols（从 `libs/agent/src` grep
  `PORT` 的 export；首个已知 `SCHEDULE_TOOLS_PORT`）
- Produces: lib-agent vitest **全绿**（与 Task C 合计 9→0）

- [ ] **Step 1: 收集 port 清单**

```bash
grep -rn "export const .*PORT\|Symbol(" libs/agent/src --include="*.ts" | grep -iv spec | grep -i port
```

- [ ] **Step 2: 测试模块补 stub**

`agent.module.test.ts` 抽 helper（4 个用例共用）：

```ts
async function compileAgentModule() {
  return Test.createTestingModule({ imports: [AgentModule] })
    .overrideProvider(SCHEDULE_TOOLS_PORT).useValue({})
    // ……逐个 port 补到 compile 通过；stub 一律最小 useValue（{} 或按 port
    // 接口的最小方法集），不引入任何行为
    .compile();
}
```

> 若 override 对「module 内未声明的 provider」无效（Nest 语义：override 只能覆盖已存在
> 的 provider），换 providers 注入形式：`Test.createTestingModule({ imports: [AgentModule],
> providers: [{ provide: SCHEDULE_TOOLS_PORT, useValue: {} }, …] })`——以先跑通
> `SCHEDULE_TOOLS_PORT` 一个为准再批量。

- [ ] **Step 3: vitest 全绿确认（S2 测试债清零时刻）**

```bash
pnpm --filter @meshbot/lib-agent test 2>&1 | grep -E "Test Files|Tests "
```

预期：**0 failed**。

- [ ] **Step 4: 提交**

```bash
pnpm check:format
git add -A && git commit -m "test(agent): agent.module 集成测试补宿主 port stub，lib-agent vitest 清零

AgentModule 的 port（SCHEDULE_TOOLS_PORT 等）由宿主 server-agent 注入，测试
模块缺失导致 4 条 DI 失败（基线预存在）。与 Task C 合计：vitest 基线 9 → 0，
今后判回归不再减基线。"
```

---

## Task 终验: 行为零变化确认

**Files:** 无源码改动。

- [ ] **Step 1: 全量自动化**

```bash
pnpm typecheck 2>&1 | grep "Tasks:"
pnpm --filter @meshbot/lib-agent test 2>&1 | grep -E "Test Files|Tests "   # 0 failed
npx jest apps/server-main/src/model-gateway apps/server-agent libs/common 2>&1 | tail -3
pnpm check 2>&1 | tail -1
```

- [ ] **Step 2: S1 探针复跑（A/B 改了运行时）**

复用 S1 的 graph 探针脚本形态（真实云模型 + Annotation 图 + createSqliteCheckpointer），
断言：messages 通道真 chunk、id 单一、assistant_done 语义单轮；再对新库调
`clearThread` 后重查两表为空（B 的 deleteThread 生效）。

- [ ] **Step 3: 快速眼验（用户）**

dev 三端在跑的话直接发一条消息（流式正常）→ 删除该会话（走 deleteThread）→ 再建会话
发消息正常。两分钟。

- [ ] **Step 4: 收官记录**

`docs/superpowers/plans/2026-07-11-langchain-1x-s2.md` 末尾追加「S2 回归结论」，
账本与记忆更新，commit。

## S2 回归结论（2026-07-11，自动化全过）

- typecheck 27/27 · jest 93 suites / 748 passed / 0 failed（socket.io-client 5 个
  suite 恢复后全绿）· 九围栏绿
- **lib-agent vitest 282/282 全绿（基线 9 → 0），今后判回归不再减基线**
- 运行时探针（真实云 DeepSeek）：Annotation 图流式 chunks=10、唯一 id、
  assistant_done=1（与迁移前逐项一致）；deleteThread checkpoints 3→0
- 实施中修正的计划偏差：D 项 overrideProvider/根 providers 均进不了模块封装，
  改 @Global stub module（计划的 fallback 再 fallback）；F 项 7 个 libs 全部
  同病（incremental 继承自 base），一并设置
- 用户眼验：发消息流式正常 + 删会话（走 deleteThread）后再发正常
