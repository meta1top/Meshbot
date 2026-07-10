# langchain 1.x 迁移 —— S0（准备）+ S1（原子升级）设计 spec

> 上游交接文档：`docs/superpowers/plans/2026-07-10-langchain-1x-migration-TODO.md`
> 本 spec 只覆盖 **S0 + S1**。S2 / S3 / S4 各自另出 spec。
> 分支：`feat/langchain-1x`（worktree `.claude/worktrees/langchain-1x`），基线 `main@7c235e1d`。

## 0. 动机与终局

终局是 **P4「显示 DeepSeek 思考链」**：langchain 1.0 把 reasoning 做成一等 standard content
block（`msg.contentBlocks` 里 `type:"reasoning"`），`ChatOpenAI` 原生支持，不再需要
`ChatDeepSeek` hack。前置的升级是必经之路。

本 spec 交付的是**通往终局的地基**：把全仓 langchain 生态一次性抬到 1.x，且**行为逐字节不变**。

## 1. 勘查结论：三条推翻原计划的事实

交接文档把迁移切成 P1（core+provider）→ P2（langgraph）→ P3（其余 provider）。这个切法
**在 lockfile 层面不成立**。

### 1.1 依赖升级必须原子

| 包 | 当前版本的 peer 约束 |
|---|---|
| `@langchain/langgraph@0.2.74` | `@langchain/core: ">=0.2.36 <0.3.0 \|\| >=0.3.40 <0.4.0"` |
| `@langchain/deepseek@0.1.0` | `@langchain/core: ">=0.3.58 <0.4.0"` |
| `@langchain/openai@0.6.17` / `anthropic@0.3.34` / `google-genai@0.2.18` / `ollama@0.2.4` | `@langchain/core: ^0.3` |

而 `langchain@1.5.3` 把 `@langchain/langgraph: ^1.4.7` 与 `@langchain/langgraph-checkpoint: ^1.1.3`
列为**硬 dependency**（不是 peer）。

叠加 `pnpm-workspace.yaml` 的 `nodeLinker: hoisted`（全仓强制单物理副本，为规避 `@nestjs/core`
分裂而设），结论是：**不存在既能编译又能运行的中间状态**。要么全 0.x，要么全 1.x。

因此原 P2（langgraph）与 P3（其余 provider）的**依赖升级被吸收进 S1**，只剩可选的代码现代化
留在 S2。

### 1.2 `.content` 没有破坏性变更

`@langchain/core@1.2.2` 的 `messages/base.d.ts:32` 仍是 `type MessageContent = string | Array<ContentBlock>`；
`contentBlocks` 是 `base.d.ts:109` 新增的 **getter**（懒计算的标准视图），构造字段里的
`contentBlocks?:` 反而标了 `@deprecated`。

全仓 7 处 `typeof x.content === "string"` 窄化照常编译。交接文档标注的「P1 风险高（消息读取/渲染
全链路）」是高估的。

### 1.3 `StateGraph({channels})` 与 `checkpointer.db` 均仍受支持

- `@langchain/langgraph@1.4.7` 的 `graph/state.d.ts:303` 保留了 `constructor(fields: StateGraphArgs<S>, ...)`
  重载（标 `@deprecated`，但可用）。`graph.builder.ts` 的自写 `mergeMessages` reducer 不必立刻迁
  `Annotation.Root`。
- `@langchain/langgraph-checkpoint-sqlite@1.0.3` 的 `SqliteSaver` 仍暴露 `db: Database` 公开字段
  （`thread-state.service.ts:28` 直取该连接删行的写法合法），并新增了官方 `deleteThread(threadId)`。

### 1.4 其余已核实的不变量

| 符号 | 结论 |
|---|---|
| `RemoveMessage` | 仍在 `@langchain/core/messages` |
| `ChatGenerationChunk` | 仍在 `@langchain/core/outputs` |
| `convertLangChainToolCallToOpenAI` / `parseToolCall` | 仍在 `@langchain/core/output_parsers/openai_tools` |
| `additional_kwargs` / `response_metadata` / `usage_metadata` / `tool_calls` / `tool_call_chunks` / `invalid_tool_calls` / `AIMessageChunk.concat` | 全部保留 |
| `initChatModel` | 仍由 `langchain@1.5.3` 的 `./chat_models/universal` 导出 |
| checkpoint 表 `checkpoints` / `writes` 的表名与列定义 | 0.1.5 → 1.0.3 **完全一致** |
| zod | 仓库 `3.25.76` 满足 `langgraph@1.4.7` 的 `^3.25.32 \|\| ^4.2.0`、`langchain@1.5.3` 的 `^3.25.76 \|\| ^4` |

新增能力：`AIMessageChunk.isInstance()` / `isAIMessageChunk()` 静态类型守卫——正是
「首帧不带 role → `instanceof AIMessageChunk` 丢弃 → chunks=0」这个老地雷的官方解药（S2 采用）。

## 2. 阶段模型

单分支、连续提交、**不切 PR**，直到用户明确指示合并。阶段边界体现为 commit 边界（保证可 bisect），
不是 CI 门禁。

| 阶段 | 内容 | 本 spec |
|---|---|---|
| **S0** | 清 dev checkpoint、锁版本矩阵、建 worktree/分支 | ✅ |
| **S1** | 原子升级 + libs/agent 瘦身 + provider 冒烟测；**行为零变化** | ✅ |
| S2 | 现代化清理：`channels`→`Annotation`、`instanceof`→`isAIMessageChunk`、`.db` 直操→`deleteThread()` | 轮廓 |
| S3 | reasoning 改读 `contentBlocks` + 云网关流式 `reasoning_content` 透传 | 轮廓 |
| S4 | web-agent 渲染思考块 | 轮廓 |

## 3. 目标版本矩阵

| 包 | 当前（lock） | 目标 | 约束来源 |
|---|---|---|---|
| `@langchain/core` | 0.3.80 | `^1.2.2` | `openai@1.5.5` 要 `^1.2.2`（最紧的下界） |
| `@langchain/openai` | 0.6.17 | **精确 `1.5.5`** | `deepseek@1.1.5` 硬钉 `@langchain/openai: "1.5.5"` exact |
| `@langchain/langgraph` | 0.2.74 | `^1.4.7` | |
| `@langchain/langgraph-checkpoint` | 0.0.18 | `^1.1.3` | 改 root override |
| `@langchain/langgraph-checkpoint-sqlite` | 0.1.5 | `^1.0.3` | deps `better-sqlite3: ^12.10.0` |
| `langchain` | 0.3.37 | `^1.5.3` | |
| `@langchain/mcp-adapters` | 1.1.3 | **不动** | 已是目标版 |
| `@langchain/anthropic` | 0.3.34 | `1.5.1` | 仅 server-main |
| `@langchain/deepseek` | 0.1.0 | `1.1.5` | 仅 server-main |
| `@langchain/google-genai` | 0.2.18 | `2.2.0` | 仅 server-main |
| `@langchain/ollama` | 0.2.4 | `1.3.0` | 仅 server-main |

### 3.1 `@langchain/openai` 必须精确钉 1.5.5

`@langchain/deepseek@1.1.5` 的 `dependencies` 里是 `"@langchain/openai": "1.5.5"`（**精确版本，非范围**）。
若我们声明 `^1.5.5`，一旦上游发布 1.5.6，pnpm 会把根 hoist 到 1.5.6，而 deepseek 仍要 1.5.5 →
树里出现两份 `@langchain/openai`。在 `nodeLinker: hoisted` 下这是真实危害。仓库现有习惯（provider
包一律精确钉）本就如此，延续即可。

### 3.2 override 调整

`pnpm-workspace.yaml`：

- `'@langchain/langgraph-checkpoint': ~0.0.18` → `^1.1.3`
- `better-sqlite3: ^12.9.0` **保留**。当前 lock 为 12.9.0；`checkpoint-sqlite@1.0.3` 要 `^12.10.0`，
  override 的 `^12.9.0` 范围能解析到 12.10+，同大版本 ABI 不变，Electron 打包链路不受影响
  （S1 末尾跑一次 desktop 构建验证）。

### 3.3 不动 zod

zod / nestjs-zod / zod-to-json-schema 全部保持现状。

## 4. S0 · 准备

### 4.1 清 dev checkpoint

**勘查修正（2026-07-10 执行时实测）：** 源码态 dev 下，checkpoint 与业务数据是**物理分离的两个文件**
（`meshbot-config.service.ts:98-108` 坐实）：

- `$MESHBOT_HOME/accounts/<id>/agent.db` —— **纯 checkpoint 库**，只有 `checkpoints` / `writes` 两张表，
  由 SqliteSaver 建/管
- `$MESHBOT_HOME/main.db` —— TypeORM 业务库，所有账号共享，含 `cloud_identity`（device_token）/
  `model_configs` / `sessions` / `session_messages` / `llm_calls` / `settings` / `pending_messages` /
  `cron_jobs`

`sqlite-checkpointer.ts` 那句「与 TypeORM DataSource（同一 agent.db）并发写」的注释描述的是**打包态**
（`isPackaged()` 走 `~/.meshbot/agent.db`，checkpoint + 业务同库）。dev 用源码态，两者已拆分。

因此清 checkpoint 的正确做法（源码态）是**直接删纯 checkpoint 文件**，最彻底（连 WAL 里的旧事务、
blob serde 残留一起清），SqliteSaver 下次启动 `setup()` 重建空表：

```bash
MESHBOT_HOME=/Users/grant/Meta1/meshbot/.meshbot   # 源码态 dev 数据根
rm -f "$MESHBOT_HOME"/accounts/*/agent.db "$MESHBOT_HOME"/accounts/*/agent.db-wal "$MESHBOT_HOME"/accounts/*/agent.db-shm
```

`main.db` 完全不碰——device_token / 会话历史都安全。删前先 tar 备份 `accounts/` 目录。

（打包态若要清则不能 `rm agent.db`——同库有业务表；但 dev 不走打包态。）

同一趟做 5.2.2 的残留行体检，体检对象是 **`main.db`**（`model_configs` 表在那，不在 account 的
checkpoint 库）。

### 4.2 建 worktree 与分支

已完成：worktree `.claude/worktrees/langchain-1x`，分支 `feat/langchain-1x`，基线 `main@7c235e1d`。

## 5. S1 · 原子升级

### 5.1 依赖改动

| package.json | 动作 |
|---|---|
| `libs/agent` | 升 `core` / `openai` / `langgraph` / `langgraph-checkpoint` / `langgraph-checkpoint-sqlite` / `langchain`；**删** `anthropic`、`google-genai`、`ollama`、`deepseek` |
| `apps/server-agent` | 升 `@langchain/core` → `^1.2.2` |
| `apps/server-main` | 升 `core` + `langchain` + **全部 5 个 provider 保留** |
| `pnpm-workspace.yaml` | 见 3.2 |

### 5.2 libs/agent 瘦身

本地轨只走云网关。`model-config-sync.service.ts:119-130` 的 `toGatewayRow` 把云端下发行的
`providerType` 恒设为 `"openai-compatible"`；本地模型写 REST 已下线。因此本地轨永远只会加载
`@langchain/openai` 一个 provider 包。

| 位置 | 动作 | 理由 |
|---|---|---|
| `libs/agent/src/graph/llm.factory.ts:15-22` | `PROVIDER_MODEL_NAME` 收敛为 `openai` + `openai-compatible` | 其余映射目标包已删 |
| `libs/agent/src/graph/llm.factory.ts:149-150` + `:177-206` | 删 `patchedFetchForDeepseek` 及其分支 | `providerType === "deepseek"` 在本地轨永不命中，死代码 |
| `libs/agent/src/graph/model-resolver.service.ts:144-146` | 删 deepseek thinking-disable 分支 | 同上，死代码 |

**明确不动**：`libs/types-agent/src/ai/providers.ts` 的 `PROVIDERS` 常量、`apps/web-main` 的
`model-form-panel.tsx` 及其 preset。那张表驱动的是**云端 `OrgModelConfig`** 配置——server-main 的
model-gateway 正是靠它选真实厂商。删掉会砍掉云端配置 Anthropic / Gemini / Ollama / DeepSeek 的能力，
那是网关的核心功能，与「本地直连」无关。

**行为影响说明**：`model-resolver.service.ts:144-146` 的 deepseek thinking-disable 分支在删除前
就已不会命中（云模型 `providerType` 是 `openai-compatible`），所以删除**不改变运行时行为**。若产品上
确实需要在 title 生成时关闭 deepseek thinking，正确落点是云网关侧，属 S3/S4 范围，本 spec 不处理。

#### 5.2.1 `PROVIDER_MODEL_NAME` 的兜底会变成运行时炸点

`llm.factory.ts:163` 是 `PROVIDER_MODEL_NAME[config.providerType] ?? config.providerType`。收敛映射表
**不会**让未知 providerType 报错，而是把原值原样传给 `initChatModel` → 动态 `import("@langchain/deepseek")`
→ 包已删 → 运行时 `ERR_MODULE_NOT_FOUND`。

两处后果必须一并处理：

- **测试 fixture**：`libs/agent/tests/unit/model-resolver-override.test.ts:26,61` 用
  `providerType:"deepseek"` / `model:"deepseek-chat"` 作**通用 fixture**（与 provider 语义无关）。
  这类 fixture 需改成 `openai-compatible`。`apps/server-agent` 下多个 spec（runner / llm-call /
  model-config / session.gateway）同样以 deepseek 作 fixture，但不触达 `initChatModel`，逐个确认后再动。
  `apps/server-agent/src/services/stats-aggregates.spec.ts:135` 的 `providerType:"anthropic"` 只是 usage
  统计数据，无需改。
- **兜底策略**：把 `?? config.providerType` 改为显式抛错（`Unsupported providerType in local track: ${x}`），
  让失败在构建模型时立刻可读，而不是退化成一条晦涩的模块解析错误。

### 5.2.2 dev 库残留行体检（S0 顺带）

`$MESHBOT_HOME/main.db` 的 `model_configs` 表里若残留 `source='local'` 且
`provider_type ∉ {openai, openai-compatible}` 的旧行，选中它就会走进 5.2.1 的炸点。S0 清 checkpoint 时
一并查询 **`main.db`**（表名 `model_configs` 复数；business 库，不是 account 的 checkpoint 库）：

```sql
SELECT id, provider_type, source FROM model_configs
WHERE source = 'local' AND provider_type NOT IN ('openai', 'openai-compatible');
```

**S0 执行时实测**：dev `main.db` 有 2 行 `source='local'` + `provider_type='deepseek'` + `enabled=1`，
且无任何 `source='cloud'` 行（dev 当时靠本地直连 DeepSeek 在跑，云网关尚未配置）。经与用户确认：
云网关将在 Task 4 眼验前配好，这 2 行**已在 S0 删除**（备份在 scratchpad）。删后 dev 在配好云网关前
无可用模型（启动会报「没有启用的模型配置」），这是预期。

### 5.3 保持不变（S1 是纯升级）

- `graph.builder.ts` 的 `new StateGraph<GraphState>({channels:{...}})` 保留（deprecated 但受支持）
- `thread-state.service.ts:28` 的 `checkpointer.db` 直取保留
- `graph-runner.service.ts` 的 `instanceof AIMessageChunk` 保留
- reasoning 仍读 `additional_kwargs.reasoning_content`（`graph-runner.service.ts:402-403,543-544`、
  `supervisor.node.ts:52-71`、`thread-state.service.ts:169-170`）
- 云网关的 `deepseekReasoningFetch`（`apps/server-main/src/model-gateway/deepseek-fetch.ts`）保留

上述任何一项若在升级后实测失败，就地修复并在 commit message 中标注「S2 提前项」。

### 5.4 新增：provider 构建期冒烟测

**问题**：`initChatModel` 的签名是 `initChatModel(model: string, fields?: Partial<Record<string, any>> & {...})`。
`configuration` / `streaming` / `modelKwargs` 全部逃过 typecheck；provider 包在编译期**没有任何静态引用**
（全仓无 `new ChatOpenAI` / `new ChatAnthropic`）。`pnpm typecheck` 对 provider 的 1.x 破坏完全瞎。

**对策**：新增 jest 冒烟测，落点 `apps/server-main/src/model-gateway/`（5 个 provider 真正
`initChatModel` 的地方）。用假 apiKey，不发真请求，断言：

1. 每个 `providerType` 都能构建出 `BaseChatModel` 实例（动态 import 没挂）
2. 构建出的实例能 `.bindTools([...])` 而不抛（签名没变）
3. `configuration.fetch` 确实被接到底层 client（拦截断言其被调用）

`libs/agent` 侧只需一条：`openai` + `buildCloudFetch`。

这三类断言正好覆盖 typecheck 盲区的三种失败模式：动态 import 失败、构造参数改名、`bindTools` 签名变更。

## 6. 埋雷清单

1. **`initChatModel` 签名是 `any` 字典** —— 见 5.4。冒烟测存在的理由。

2. **`ChatOpenAI` 1.x 分裂成 Completions / Responses 双实现**。
   `dist/chat_models/index.js:574` 的 `_useResponsesApi()` 返回
   `useResponsesApi || usesBuiltInTools || hasResponsesOnlyKwargs || hasCustomTools || _modelPrefersResponsesAPI(this.model)`；
   而 `dist/utils/misc.js:40` 的 `_modelPrefersResponsesAPI` 在模型名含
   `gpt-5.2-pro` / `gpt-5.4-pro` / `gpt-5.5-pro` / `codex` 时返回 true。

   命中即改打 `/responses`，而我们的云网关**只实现了 `/chat/completions`** → 404。当前在用的模型名
   不命中，但这是产品级陷阱：任何人把 OrgModelConfig 的 model 命名成带 `codex` 的字样，或将来启用
   built-in tools / `customTool`，就会踩中。写入 S1 的风险清单，S3 考虑在网关侧显式 `useResponsesApi: false`。

3. **`@langchain/openai` 内部 SDK 从 `openai@4/5` 跳到 `openai@6`** —— 本次 provider 跨度最大的一个。

4. **老地雷复验**：网关流式首帧必须带 `role:"assistant"`，否则端侧建成 generic `ChatMessageChunk`，
   被 `graph-runner` 的 `instanceof AIMessageChunk` 丢弃（chunks=0，有回复也不显示）。1.x 下重验此路径。

5. **`@langchain/mcp-adapters@1.1.3` 的 peer 当前根本没被满足**（要 `core ^1.0.0` + `langgraph ^1.0.0`，
   而仓库是 core 0.3 + langgraph 0.2）。升级后反而变正确。这说明 MCP 工具链目前跑在未声明支持的
   peer 组合上——S1 后需回归 MCP 工具链。

6. **DeepSeek thinking 多轮**：历史 assistant 消息需带 `reasoning_content`（网关 `deepseekReasoningFetch`
   注入空串）。1.x content blocks 后确认是否仍需——S3 处理，S1 原样保留。

7. **server-main dev 跑的是编译产物 `dist/main`**，改源码后需重启才生效（非纯 watch 热更）。

## 7. S1 验收标准

「完成」的定义，全部满足方可进 S2：

- `pnpm typecheck` 全包绿
- 针对性 jest 绿：`libs/agent/tests/unit`、`apps/server-agent`、`apps/server-main/src/model-gateway`
  （全量 `pnpm test` 有既存无关失败：vitest 文件被根 jest 误拾）
- `pnpm check` 九个静态围栏绿（tx / naming / lock-tx / repo / scope / dead / error-code / pk / dev-script）
- `libs/agent` vitest **对齐既存基线**——`main` 上已有 9 个预存在失败（agent.module DI + graph/supervisor mock），
  判回归要 diff 失败集合，不是看是否全绿
- desktop 构建跑一次，验 `better-sqlite3` 12.10+ 的 Electron ABI
- provider 冒烟测（5.4）全绿
- **端到端眼验**：重启 server-agent + server-main + web-agent，真实模型：
  - 云 DeepSeek 能出话、流式正常、token 气泡非 0
  - 工具调用 / 多轮 / HITL 确认卡 / 子 agent dispatch 不回归
  - MCP 工具链不回归
- **行为零变化**：reasoning 的采集与展示与升级前一致（`additional_kwargs.reasoning_content`）。
  S1 不引入任何 `contentBlocks` 读取。

### 7.1 无法眼验的部分（风险清单）

`anthropic` / `google-genai` / `ollama` 三个 provider 在 server-main 网关侧升级后，**无真实 apiKey
做端到端验证**。保障手段仅为 5.4 的构建期冒烟测。这三个 provider 的真实请求/响应路径（尤其
`google-genai` 从 0.2 跨到 2.2，两个主版本）在 S1 后仍属未验证状态，需在首次真实使用时留意。

## 8. 后续阶段轮廓（不在本 spec 范围）

- **S2 现代化**：`StateGraph({channels})` → `Annotation.Root`（或 1.1 的 Zod `StateSchema`）；
  `instanceof AIMessageChunk` → `isAIMessageChunk()`；`thread-state.service.ts` 的 `.db` 直操 →
  官方 `deleteThread()`。
- **S3 reasoning**：`graph-runner` / `supervisor.node` / `thread-state` 的 reasoning 采集从
  `additional_kwargs.reasoning_content` 迁到 `contentBlocks` 的 `type:"reasoning"` block；
  云网关流式 `delta` 吐 `reasoning_content`。
- **S4 前端**：web-agent 渲染思考块。前端零 langchain 依赖，经 `libs/types-agent` 的
  `HistoryMessageSchema.reasoning` 与 `StreamChunk` 的 `reasoning` / `reasoning_done` 事件消费。
