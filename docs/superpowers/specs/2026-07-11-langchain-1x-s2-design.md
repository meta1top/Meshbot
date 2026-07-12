# langchain 1.x 迁移 —— S2（现代化 + 全面还债）设计 spec

> 上游：`2026-07-10-langchain-1x-s0-s1-design.md`（S0+S1 已收官，`0fcb569b`）。
> 分支 `feat/langchain-1x` 连续提交，不切 PR。S2 之后是 S3 reasoning（动机）。

## 0. 目标

S1 求稳留下的 deprecated 用法与测试债务，本阶段一次清完。两个测试栈清零
（lib-agent vitest 基线 9 → **0**；server-agent jest 5 个 import 崩 suite → **0**），
外加两处工作流地雷根治。运行时**行为零变化**。

## 1. 工作项（7 项）

### A. State 迁移：`{channels}` → `Annotation.Root`

`libs/agent/src/graph/graph.builder.ts:95-102` 的 deprecated 重载：

```ts
// 现状
new StateGraph<GraphState>({ channels: { messages: { value: mergeMessages, default: () => [] } } })
// 目标
const GraphAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: mergeMessages, default: () => [] }),
});
new StateGraph(GraphAnnotation)
```

- `mergeMessages` reducer 逻辑**一行不动**（含 S1 已修的 `_getType()==="remove"` 判定）。
- `GraphState` 接口改为 `typeof GraphAnnotation.State` 派生（或保留 interface 并断言两者一致），
  联动 `supervisor.node.ts`（SupervisorState）/ `tools.node.ts` / `graph-runner.service.ts` /
  `graph.types.ts` 的类型引用。以 typecheck 为准，逐处最小改。
- 子图（dispatch_subagent 的 buildSubagentGraph，若同样用 {channels}）一并迁移。

选型记录：不用 Zod StateSchema（1.1+ 新推荐）——自定义 reducer 要走 MessagesZodMeta/
withLangGraph 元数据机制，mergeMessages 需重写，S2 求稳选官方迁移第一档 Annotation.Root。

### B. checkpointer 官方化：`.db` 直删 → `deleteThread()`

`thread-state.service.ts:27-40` 的 `clearThread` 现用 `checkpointer.db` 直接
`DELETE FROM checkpoints/writes`（0.x 时代无官方 API 的权宜）。checkpoint-sqlite 1.0.3
提供了官方 `deleteThread(threadId): Promise<void>`。

- `clearThread(threadId): void` → `async clearThread(threadId): Promise<void>`，内部调
  `checkpointer.deleteThread(threadId)`。
- 消费方 `apps/server-agent/src/services/checkpointer-cleanup.service.ts:20` 跟着 await。
- `thread-state.service.ts` 其余 `.db` 用法（若有 cutoff 裁剪等直查）**本项不动**——
  只迁 clearThread 这一处有官方等价物的；其余直查是读侧优化，deleteThread 覆盖不了。
- `sqlite-checkpointer.ts` 的自建连接 + WAL pragma 保留（deleteThread 用同一连接）。

### C. graph 类 mock 重写：`FakeStreamingChatModel`

vitest 5 条失败（graph-runner 3 + supervisor 2）根因：手写 mock BaseChatModel 子类走
`handleLLMNewToken` 旧通道，1.x 基类包装时 chunk 丢 id、产物非真 chunk，被 runner 的
`concat` 判别挡下（chunks=0）。

- 用 `@langchain/core/utils/testing` 的官方 fake（`FakeStreamingChatModel` 或同模块可
  流式、可带 tool_calls/usage_metadata 的 fake；实施时以 1.2.2 实际导出为准），走 1.x
  真实事件通道（`_streamChatModelEvents`），chunk 带 id、是真 AIMessageChunk。
- 若官方 fake 不支持自定义 chunk id / usage_metadata / tool_call_chunks（这些测试都要），
  fallback：手写 fake 但实现 1.x 的流式协议（子类化后 override `_streamResponseChunks`
  并确认基类透传 message 而非从 text 重建——以实验为准）。
- 受影响文件：`tests/unit/graph-runner.test.ts`（含「收口为雪花」共 4 个用例的 mock）、
  `tests/unit/supervisor.node.test.ts`（2 用例 + `resolveMessageId is not a function`
  的 mock hoisting 问题一并修）、`src/graph/nodes/supervisor.node.spec.ts`（同名 jest
  spec 若同病同修）。

### D. agent.module DI 测试清零

4 条失败根因（已勘实）：`Test.createTestingModule({ imports: [AgentModule] })` 缺宿主
注入的 port providers，首个报错 `SCHEDULE_TOOLS_PORT`。

- 测试模块补全部宿主 port 的 stub（`SCHEDULE_TOOLS_PORT` 起，逐个补到 compile 通过；
  预计还有 IM_SEND / ASK_QUESTION / DISPATCH_SUBAGENT / DRIVE / MEMORY 系）。
- stub 用 `useValue` 最小对象；抽一个 `provideHostPortStubs()` helper 放测试侧复用。

### E. vitest 根治：排除 dist

`libs/agent/vitest.config.ts` 加 `test.exclude`（在默认排除之上加 `dist/**`）。
根治「跑 vitest 必须先 rm dist，否则 20 个 dist/*.spec.js CJS 假失败」。

### F. tsc 缓存根治：tsBuildInfoFile 落进 dist

`libs/agent/tsconfig.json` 显式 `"tsBuildInfoFile": "./dist/tsconfig.tsbuildinfo"`。
根治「rm dist 后 build 空 emit」（缓存随 dist 一起删）。本次迁移此坑咬了四次。
顺手检查其他 libs/* 是否同病（有则一并设，无则只动 lib-agent）。

### G. jest ESM stub：socket.io-client

server-agent 5 个 suite import 崩（`Cannot find module 'socket.io-client'`——ESM-only
包，ts-jest CJS 解析不了 export map；基线预存在）。同 `@vscode/ripgrep` 先例：

- `test/mocks/socket-io-client.js` CJS stub（导出 `io` 等被 import 的符号的空实现）。
- 根 `jest.config.ts` `moduleNameMapper` 加一行映射。
- 受益 suite：`remote-device-query.service.spec` + 4 个 e2e spec。注意 e2e 里若真要用
  socket 功能则 stub 需按其断言塑形——实施时看测试内容定 stub 粒度。

## 2. 验收标准

- `pnpm --filter @meshbot/lib-agent test`：**0 failed**（不再需要「减基线」）
- `npx jest apps/server-agent libs/common`：**0 failed 且 0 suite import 崩**
- `pnpm typecheck` 27/27 · `pnpm check` 九围栏绿
- **行为零变化验证**（A/B 动了运行时代码）：
  - S1 的 graph 探针复跑：单轮、assistant_done=1、chunk id 保留、checkpointer put/get 正常
  - 快速眼验：发一条消息流式正常；清一次会话（走新 deleteThread）后再发正常
- 不碰：reasoning 链路（S3）、server-main、`PROVIDERS`、web 前端

## 3. 风险与回退

- A 的类型联动是最大不确定面：`GraphState` 派生类型变化可能在 runner/nodes 渗出类型
  噪音。纪律同 S1：最小修复、禁 as any 消音、语义变更即停。
- C 若官方 fake 能力不足，fallback 手写 1.x 协议 fake——以「测试红因可解释」为底线，
  不许为绿而绿（断言弱化）。
- 每项独立 commit，任何一项翻车可单独 revert，不连坐。
