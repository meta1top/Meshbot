# langchain 1.x 迁移 —— S3（reasoning 端到端）设计 spec

> 上游：S0-S2 已收官（S2 @ cc452c33，两个测试栈清零）。分支 `feat/langchain-1x`
> 连续提交，不切 PR。S3 是整个迁移的**动机**：思考过程端到端流式显示。

## 0. 目标（用户原话）

1. 我们兼容的 API 接口可以兼容**所有厂商**的思考过程；
2. 本地只使用**一种方式**支持思考过程；
3. 客户端正常流式显示思考过程。

## 1. 四个决定性实验（写 spec 前已全部在 1.x 实测）

| # | 实验 | 结论 |
|---|---|---|
| 1 | 手造 DeepSeek SSE 喂 `ChatDeepSeek@1.1.5` | reasoning **双路都有**：`additional_kwargs.reasoning_content` + `contentBlocks` 的 `type:"reasoning"` |
| 2 | 手造 `delta.reasoning_content` SSE 喂 `ChatOpenAI@1.5.5` | **原生解析**进 `additional_kwargs.reasoning_content`（0.6.17 不解析——当年上 ChatDeepSeek hack 的根因，1.x 官方修了）；completions 线 `contentBlocks` **无** reasoning block |
| 3 | 带 reasoning 历史喂 `ChatDeepSeek@1.1.5` 抓请求体 | **不回写** `reasoning_content` 到历史 assistant → 网关 `deepseekReasoningFetch`（补空串过 DeepSeek 校验）**保留** |
| 4 | 手造 Anthropic thinking SSE 喂 `ChatAnthropic@1.5.1` | thinking **只落** `contentBlocks` reasoning（`additional_kwargs` 无）——standard blocks 是跨厂商唯一统一视图 |
| 5 | 手造 Gemini thought part SSE 喂 `ChatGoogleGenerativeAI@2.2.0` | thought **只落** `contentBlocks` reasoning（AK 仅 thought_signatures 内部键）——提取器天然覆盖 |
| 6 | 手造 Ollama thinking NDJSON 喂 `ChatOllama@1.3.0` | **双路都有**（contentBlocks reasoning + AK.reasoning_content）——提取器覆盖且双路去重生效 |

**实验矩阵结论：四大厂商（DeepSeek/Anthropic/Google/Ollama）的思考输出在 1.x 下
100% 落在 contentBlocks 标准视图——extractReasoningDelta 的 ① 路通吃，② 路
（AK 兜底）覆盖未来仅走 DeepSeek 风格扩展的 openai-compatible 上游。**

## 2. 架构：三层各一个不变量

```
【网关入口】各厂商 chunk ──→ extractReasoningDelta(chunk)
    读序：① contentBlocks 里 type:"reasoning" 的增量（标准路，覆盖 DeepSeek/Anthropic 已证）
          ② fallback additional_kwargs.reasoning_content（兼容路）
          两路都有时只取 ①（DeepSeek 双路，防重复）
【网关出口】唯一 wire 字段：OpenAI 官方格式 + `delta.reasoning_content` 扩展
    （官方 chat completions 无思考字段——OpenAI 不下发思考原文；reasoning_content 是
     DeepSeek 开头、Qwen/GLM/Kimi 等跟进、langchain ChatOpenAI 原生解析的行业事实标准。
     标准客户端忽略未知字段，兼容性零影响。）
【本地轨】唯一方式：ChatOpenAI 原生解析 → additional_kwargs.reasoning_content
    → graph-runner 现有采集（零改动）→ reasoning/reasoning_done 事件（零改动）
    → SessionMessage.reasoning 落库（零改动）→ 前端思考块折叠区/思考中Xs（零改动）
```

**standard content blocks 的兑现位置**（回应「升级图什么」）：网关 `extractReasoningDelta`
读一个标准视图吃遍所有厂商——0.x 时代各家落点不同（Anthropic thinking block /
DeepSeek additional_kwargs / Gemini thought part），要写 N 套提取。端侧 hack 清零
（0.6.17 不解析 reasoning_content → 1.x 原生解析）同为升级兑现。

**立此存照**：端侧 graph-runner **不迁** contentBlocks——实验 2 证明 ChatOpenAI
completions 线的 contentBlocks 无 reasoning block（上游库现状），
`additional_kwargs.reasoning_content` 就是 1.x ChatOpenAI 解析 reasoning 的官方输出
位置。将来上游 blocks 化后迁移点只有 graph-runner 一处采集。另：standard content
blocks 是**进程内消息模型**的标准，不是 HTTP wire 标准——wire 层本无官方思考字段。

## 3. 改动清单（全部在 apps/server-main/src/model-gateway/）

### 3.1 `openai-adapter.ts`：新增 `extractReasoningDelta`

```ts
/** 从各厂商 chunk 归一提取思考增量：contentBlocks reasoning 优先，AK 兜底。 */
export function extractReasoningDelta(chunk: AIMessageChunk): string
```

- ① 遍历 `chunk.contentBlocks`，拼接 `type === "reasoning"` 的 `reasoning` 字段；
- ② ① 为空则取 `additional_kwargs.reasoning_content`（string 时）；
- 纯函数，独立单测。

### 3.2 `model-gateway.service.ts` `stream()`

- 每 chunk 调 `extractReasoningDelta`；
- yield 条件 `content || toolCalls` 扩为 `content || toolCalls || reasoning`
  （纯思考帧现在会被静默跳过——这是全链路唯一真正的「缺口」）；
- delta 形状：`{ ...(首帧 role), ...(reasoning ? { reasoning_content: reasoning } : {}),
  content, ...(toolCalls…) }`；
- **不破坏两个既有约定**：首帧带 `role:"assistant"`（思考帧通常先到，role 就落在首个
  思考帧上——端侧 ChatOpenAI 对带 role+reasoning_content 的首帧解析已被实验 2 覆盖）、
  usage 末帧顺序不变。

### 3.3 `openai-adapter.ts` `toOpenAICompletion()`

非流式 message 带 `reasoning_content`（`extractReasoningDelta(result)` 非空时）。
一行级；端侧非流式路径（标题生成）不消费思考，此为 API 完整性。

### 3.4 实验矩阵补全（实施期，不 block 架构）

Google（`ChatGoogleGenerativeAI@2.2.0` 手造 thought part wire）与 Ollama
（`ChatOllama@1.3.0` 手造 thinking 字段 wire）各做一次实验 1/4 同款：落点若在
contentBlocks / AK 任一路 → 提取器天然覆盖；两路皆无 → 该厂商暂无思考输出，
记录事实即可，不改架构。

### 3.5 保留不动

`deepseekReasoningFetch`（实验 3）；`PROVIDER_MODEL_NAME`；libs/agent 全部；
web 前端全部；`libs/types` 的 `openai-chat.schema.ts`（响应侧无 schema 校验，
`reasoning_content` 是新增输出字段不受影响——实施时复核请求 schema 确无冲突）。

## 4. 测试与验收

- **单测**：`extractReasoningDelta`（DeepSeek 双路只取一 / Anthropic 仅 blocks /
  纯 AK / 全空）；gateway stream spec 新增：纯 reasoning 帧输出、reasoning+content
  混帧、首帧 role 落在思考帧、usage 末帧顺序不变（现有 spec 已钉后两者，扩展用例）。
- **回归**：gateway jest 全绿；lib-agent vitest 保持 282/282；typecheck；九围栏。
- **端到端眼验**（真实 DeepSeek reasoner，经云网关）：
  1. 发问 → 前端思考块先流式展开（「思考中 Xs」计时）→ 正文接续 → 「已思考 Xs」定格；
  2. `session_messages.reasoning` 列落库，刷新页面思考块还在；
  3. 多轮对话正常（deepseekReasoningFetch 兜底历史校验）；
  4. 工具调用轮 reasoning → tool_calls 切换时 `reasoning_done` 事件正常（前端
     「思考中→已思考」切换）。

## 5. 风险

- 唯一实质风险在 3.2 的 yield 条件与帧形状——由现有 spec 的 role/usage 用例 +
  新增用例双重钉住。
- 端侧对「role 落在纯思考首帧」的解析已被实验 2 直接覆盖（实验帧序恰为
  role+reasoning → reasoning → content）。
- 改动全部在网关一个模块内，单 commit 可整体 revert。
