# langchain 0.6/0.3 → 1.x 全仓迁移 TODO / 交接

> 交接文档。**不是**可直接执行的 plan —— 每个阶段需各自走 brainstorm→spec→writing-plans→SDD。
> 动机:云网关端到端保真的最后一块「显示 DeepSeek 思考链(reasoning)」。langchain 1.0 把 reasoning 做成**一等 standard content block**(`msg.contentBlocks` 里 `type:"reasoning"`;流式 `for await (const delta of message.reasoning)`),ChatOpenAI 原生支持——不再需要 ChatDeepSeek hack。顺带现代化整套 langchain。

## 决策前提（已与用户确认）

- **不兼容老数据、无负担、大胆升**:dev 的 `~/.meshbot` 或 repo 根 `.meshbot/`(见 `resolveMeshbotDir`：源码态 = `<repoRoot>/.meshbot`)里各账号 `accounts/<id>/agent.db` 的 LangGraph checkpoint 可**直接清空重建**,不需 checkpoint 格式兼容。
- 独立分支、独立于已合并的网关工作(本 TODO 所在 PR 已把 DeepSeek 接入 + 流式 role 修复 + usage 透传合入 main)。

## 现状足迹（源码，2026-07-10）

源码里声明 langchain 的仅 3 处 package.json：

- **libs/agent**（agent 编排核心，破坏面最大）：`@langchain/core ^0.3`、`@langchain/langgraph ^0.2`、`@langchain/langgraph-checkpoint ~0.0.18`、`@langchain/langgraph-checkpoint-sqlite ^0.1`、`@langchain/openai 0.6.17`、`@langchain/deepseek 0.1.0`、`@langchain/anthropic 0.3.34`、`@langchain/google-genai 0.2.18`、`@langchain/ollama 0.2.4`、`@langchain/mcp-adapters ^1.1.3`、`langchain ^0.3.37`
- **apps/server-agent**：`@langchain/core ^0.3`
- **apps/server-main**：`@langchain/core ^0.3` + openai/anthropic/google-genai/ollama/deepseek + `langchain ^0.3.37`（云模型网关 `apps/server-main/src/model-gateway/`）

破坏面重点文件（libs/agent，勘查起点）：
- `src/graph/graph-runner.service.ts`（`graph.stream` streamMode `["messages","updates"]`、chunk 消费、`instanceof AIMessageChunk` 过滤、reasoning 从 `additional_kwargs.reasoning_content` 采集 → 1.x 改读 content blocks）
- `src/graph/nodes/supervisor.node.ts`（`model.stream`、`AIMessageChunk.concat`、剥 `additional_kwargs.reasoning_content`）
- `src/graph/llm.factory.ts`（`initChatModel`、provider 映射、`patchedFetchForDeepseek`、`buildCloudFetch`）
- `src/graph/model-resolver.service.ts`、`config/model-config.reader.ts`（模型构建/缓存）
- checkpointer（langgraph-checkpoint-sqlite）初始化处
- MCP：`@langchain/mcp-adapters`
- 网关 `apps/server-main/src/model-gateway/openai-adapter.ts` + `model-gateway.service.ts`（消息/流式/usage 形状）

## 目标版本矩阵（实现时用 context7 / npm view 复核最新）

- `@langchain/core` → 1.x（1.0 已发布；标准 content blocks）
- `@langchain/openai` → 1.x（npm latest 曾见 1.5.5）
- `@langchain/anthropic` → 1.x（1.0 已发布）
- `langchain` → 1.x
- `@langchain/langgraph` → 1.x（+ `langgraph-checkpoint` / `checkpoint-sqlite` 对齐；1.1 有 Zod 原生 `StateSchema`）
- `@langchain/deepseek` / `google-genai` / `ollama` / `mcp-adapters` → 与 core 1.x 兼容的最新（部分对新 content blocks「逐步支持」，功能可用即可）
- server-agent / server-main 的 `@langchain/core` 同步

## 分阶段（每阶段独立 spec→plan→SDD→回归；顺序建议如下）

- **P0 准备**：清 dev checkpoint（`accounts/*/agent.db`）;`npm view` 锁定各包 1.x 具体版本 + peerDeps 兼容矩阵;建独立 worktree/分支。
- **P1 core + provider + 内容块**：升 `core/openai/anthropic/langchain` → 1.x;改 libs/agent + 网关里**消息内容模型**破坏性变更(content string ↔ contentBlocks);全量 `pnpm typecheck` + 根 jest 绿。**风险高**(消息读取/渲染全链路)。
- **P2 langgraph**：升 `langgraph` + checkpoint 到 1.x;修 StateGraph/Annotation(或迁 StateSchema)/streamMode/interrupt(HITL)API;**重验刚修好的流式三件套**(role 首帧 / usage 帧 / chunks=AIMessageChunk)与远程 HITL。**风险高**(编排心脏)。
- **P3 其余 provider**：deepseek/google-genai/ollama/mcp-adapters 对齐;MCP 工具链回归。
- **P4 reasoning 显示（动机）**：网关流式 `delta` 吐 `reasoning_content`(取自上游 chunk 的 reasoning content block/`additional_kwargs`);agent 侧改用 1.x content blocks 读 reasoning(`graph-runner` 的采集从 `additional_kwargs.reasoning_content` 迁到 `contentBlocks` reasoning);web-agent 渲染思考块。之前的探索证据:0.6.17 的 ChatOpenAI 不解析 reasoning_content;ChatDeepSeek 会(`additional_kwargs.reasoning_content`)——1.x 后统一走 content blocks。

## 回归底线（每阶段跑）

- 针对性 jest（全量 `pnpm test` 有既有无关失败:vitest 文件被根 jest 误拾）+ `pnpm typecheck` 全包 + `pnpm check` 静态围栏。
- 端到端眼验(重启 server-agent + server-main + web-agent,真实模型):云 DeepSeek 能出话、流式、token 气泡非 0、(P4 后)显示思考;工具调用/多轮/HITL/子 agent dispatch 不回归。
- CI（GitHub origin，PR + 必需 ci 绿）。

## 关键已知坑（本轮调试沉淀，迁移时别踩）

- 网关流式**首帧必须带 `role:"assistant"`**,否则端侧建成 generic ChatMessageChunk,被 graph-runner `instanceof AIMessageChunk` 丢弃(chunks=0,有回复也不显示)。1.x content blocks 下重验此路径。
- 网关流式 usage 走 OpenAI include_usage 末尾帧(`{choices:[],usage}`);非流式 completion 带 `usage`。
- DeepSeek thinking 多轮:历史 assistant 消息需带 `reasoning_content`(网关 `deepseekReasoningFetch` 注入空串);1.x content blocks 后确认是否仍需。
- server-main 云网关对各 provider 经 `initChatModel` 构建;deepseek 走 `@langchain/deepseek`,openai-compatible 映射成 openai。
- server-main dev 跑的是编译产物 `dist/main`,改源码后**需重启**才生效(非纯 watch 热更)。
