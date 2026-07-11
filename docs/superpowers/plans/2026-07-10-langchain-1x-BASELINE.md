# langchain 1.x 迁移 · 0.x 基线报告（Task 0 产出）

分支 `feat/langchain-1x-migration`，采集于 S0（langchain 仍 0.x，未升级）。
持久化在 tracked 文件（scratchpad 会被清理）。后续 Task 3 升级后按此判回归。

## 复现姿势（顺序关键，两个约束互相冲突）

```bash
cd <worktree>

# 1) typecheck（不依赖 dist）
pnpm typecheck

# 2) 需 lib-agent 编译产物的 jest：先 build
#    （@meshbot/lib-agent 的 main 是 ./dist/index.js，jest.config 未给它配
#     moduleNameMapper，走 node resolution → 需 dist/index.js 存在，
#     否则 48 suite 全 Cannot find module '@meshbot/lib-agent'）
pnpm --filter @meshbot/lib-agent build
npx jest apps/server-main/src/model-gateway
npx jest apps/server-agent libs/common

# 3) libs/agent vitest：必须先删 dist
#    （vitest.config 未排除 dist，会误扫 dist/**/*.spec.js，
#     编译后的 spec 用 CJS require("vitest") 必崩，产生 ~20 个假 file 失败）
rm -rf libs/agent/dist
pnpm --filter @meshbot/lib-agent test

# 3b) ⚠️ vitest 跑完想恢复 dist 时，必须连 tsbuildinfo 一起删再 build：
#     tsc 增量缓存在包根 libs/agent/tsconfig.tsbuildinfo（不在 dist 里），
#     只 rm dist 后再 build，tsc 判定 up-to-date 什么都不 emit → dist 残缺
#     → server-agent typecheck/build 报"缺导出/implicit any/找不到模块"的幽灵错误。
#     turbo cache hit 同样不回填被手删的 dist。
rm -f libs/agent/tsconfig.tsbuildinfo
pnpm --filter @meshbot/lib-agent build

# 4) 九个静态围栏
pnpm check
```

## 基线结果（0.x）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 全绿 27/27 |
| gateway jest（`apps/server-main/src/model-gateway`） | ✅ 27 passed（Task 1 后 +7 = 34） |
| `apps/server-agent` + `libs/common` jest（先 build lib-agent） | **889 tests 全 passed**；5 suite import 阶段崩（见 B，预存在，0 真实 test 失败） |
| `libs/agent` vitest（先 rm dist） | **9 个预存在失败**（见 A） |
| `pnpm check`（九围栏） | ✅ 全绿 exit 0 |

## 预存在失败清单（判回归时忽略这些）

### A. libs/agent vitest —— 9 个真实 test 失败（3 file）

与 memory「libs/agent vitest 基线失败」一致（agent.module DI + graph/supervisor mock）：

- `tests/integration/agent.module.test.ts` ×4
  - compiles and provides GraphRunner
  - provides MeshbotConfigService
  - provides PromptService
  - provides ToolRegistry
- `tests/unit/graph-runner.test.ts` ×3
  - resumeStream 不加新消息，从现有状态继续流式
  - streamMessage 末尾 yield usage 事件含 token 明细
  - streamMessage 逐 chunk 产出 token 与稳定 messageId
- `tests/unit/supervisor.node.test.ts` ×2
  - 把完整消息历史传给 model.stream
  - 调用注入的 model.stream 并把累加后的 AIMessage 追加到 state

### B. server-agent jest —— 5 suite import 阶段崩（0 test 失败）

根因：`Cannot find module 'socket.io-client'`。它物理存在但是 ESM-only，jest（ts-jest
CommonJS）无法解析 export map（同 memory「@vscode/ripgrep ESM-only 需 jest mock 桩」，
只是没配桩）。**与 langchain 无关**，预存在。

- `apps/server-agent/src/cloud/remote-device-query.service.spec.ts`
- `apps/server-agent/test/e2e/session.e2e.spec.ts`
- `apps/server-agent/test/e2e/auth-profile.e2e.spec.ts`
- `apps/server-agent/test/e2e/im-inbox.e2e.spec.ts`
- `apps/server-agent/test/e2e/device-agent-reverse.e2e.spec.ts`

## 判回归方法

升级到 1.x 后同样姿势跑：
- typecheck / gateway jest / pnpm check：必须仍全绿
- server-agent jest：仍 889 passed + 同 5 个 socket.io-client suite 崩（名单数量不变即无回归）
- libs/agent vitest：失败集合必须与 A 的 9 个**完全一致**（不多不少）
- provider-smoke.spec.ts：7/7 绿（不加 --forceExit 也退出码 0）

## S0 数据操作（已执行，主仓 .meshbot）

- 清空 `$MESHBOT_HOME/accounts/*/agent.db`（纯 checkpoint 库，rm 文件；备份 tar 在 scratchpad）
- 删 `main.db` 的 2 行 `source='local'` + `deepseek` 残留配置（备份 dump 在 scratchpad）
- device_token（cloud_identity）/ 会话历史在 main.db，未受影响

## 环境教训（重要）

`feat/langchain-1x` 分支曾被另一个并发 Claude session 共享操作（他们 checkout+stash 后切走，
把分支 ref 拖回其 stash 前状态，抹掉了我的 commit）。**本工作已迁到独立分支
`feat/langchain-1x-migration` 隔离**。判回归时若发现 HEAD/文件异常回退，先 `git worktree list`
+ `git rev-parse --abbrev-ref HEAD` 确认没被其他 session 影响。

## S1 修正后的 vitest 失败集合（isAIMessageChunk 修复后，2026-07-11）

基线 9 → **7**，每条进出可归因：

- **-3 治愈**（graph-runner：逐 chunk / usage / resumeStream）——根因与生产 bug 同源：
  instanceof AIMessageChunk 在 core 1.x ESM/CJS 双构建下恒 false，改
  isAIMessageChunk() 结构判定后测试与生产一并恢复。
- **+1 新增**（graph-runner：同一轮 messageId 收口为雪花）——mock 的 BaseChatModel
  走 handleLLMNewToken 旧通道，1.x 基类包装时 chunk.id 丢失 → 每 chunk randomUUID
  被判两轮。**生产路径已探针证实 id 保留、单轮正确**（真实流全 chunk 同
  chatcmpl-… id）。与 supervisor×2 同属 mock 机制错位，S2 修测试 mock。
- 其余 6（agent.module×4 + supervisor×2）与基线一致。
