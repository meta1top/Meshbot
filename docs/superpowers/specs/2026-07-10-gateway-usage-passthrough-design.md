# 云网关透传 token usage 设计 spec

**日期:** 2026-07-10
**分支:** 当前 worktree 分支 `worktree-gateway-deepseek`（接续 DeepSeek 接入 + 流式 role 修复，同属"云模型网关端到端保真"）

## 背景与问题

云模型网关（server-main）的 OpenAI 适配 `toOpenAICompletion` / `toOpenAIChunk` 只吐 `content` + `tool_calls`，**不带 `usage`**。于是端侧 agent 的 `[LLM end]` 报 `no usage_metadata`（graph-runner `flushRound` 里 `extractUsage` 拿不到 usage → 打告警、不 yield usage 事件）→ **不记 `llm_calls`**、web 端"下次预估 / 输入 / 输出 / 累计 / 次调用"token 气泡**全 0**。所有云模型都受影响。

**已验证的关键事实**（mock SSE 喂 `@langchain/openai` ChatOpenAI）：端侧 `ChatOpenAI` 流式**会**把网关按 OpenAI `include_usage` 约定补的末尾 usage 帧（`{choices:[], usage:{...}}`）解析进 `usage_metadata`（实测得 `{input_tokens,output_tokens,total_tokens}`）。而 agent 侧 `extractUsage → usage 事件 → LlmCall → 气泡`链路**已存在**（直连模型就这么记的）。所以只要网关把 usage 按规范吐出来，端侧全自动，**无需改 agent**。

## 目标

- 网关把上游模型 token 用量按 OpenAI 规范透传给端侧（流式 + 非流式）。
- 端侧恢复 `llm_calls` 记录与 token 气泡；消除 `[LLM end] no usage_metadata` 告警。
- 面向**所有**云模型，非仅 DeepSeek。

## 非目标（YAGNI）

- **不**做 reasoning 思考链显示（另立一项：langchain 不解析 `delta.reasoning_content`，需端侧定制）。
- **不**改 server-agent / libs/agent（端侧已能解析 usage）。
- **不**新增依赖；**不**改鉴权 / 解析 / 路由。

## 改动（仅 server-main model-gateway）

**文件:**
- Modify `apps/server-main/src/model-gateway/openai-adapter.ts`
- Modify `apps/server-main/src/model-gateway/model-gateway.service.ts`
- Modify `apps/server-main/src/model-gateway/model-gateway.service.spec.ts`（补断言）
- 可能 Modify `apps/server-main/src/model-gateway/openai-adapter.spec.ts`（若存在；否则断言放 service spec）

**逻辑:**

1. **usage 映射**（openai-adapter.ts 新增内部 helper）：langchain `UsageMetadata`（`{input_tokens, output_tokens, total_tokens}`）→ OpenAI `usage`（`{prompt_tokens, completion_tokens, total_tokens}`）。字段缺失按 0 兜底。
   ```ts
   type LcUsage = { input_tokens?: number; output_tokens?: number; total_tokens?: number };
   function toOpenAIUsage(u: LcUsage) {
     return {
       prompt_tokens: u.input_tokens ?? 0,
       completion_tokens: u.output_tokens ?? 0,
       total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
     };
   }
   ```

2. **非流式** `toOpenAICompletion(msg, model, id)`：当 `msg.usage_metadata` 存在时，在返回对象加顶层 `usage: toOpenAIUsage(msg.usage_metadata)`。无则不加（保持兼容）。

3. **流式末尾 usage 帧** `toOpenAIUsageChunk(usage, model, id)`（openai-adapter.ts 新增）：产出 `{ id, object:"chat.completion.chunk", created:0, model, choices:[], usage }`（OpenAI include_usage 约定：choices 空、带 usage）。

4. **`model-gateway.service.ts` `stream()`**：遍历上游 `model.stream()` 时记录末个非空 `chunk.usage_metadata`（langchain 流式末帧携带）。内容帧 + 现有 finish 帧发完后，若拿到 usage，再 `yield toOpenAIUsageChunk(toOpenAIUsage(usage), req.model, id)`。**无条件发**（不看 req.stream_options）——唯一消费者是 agent ChatOpenAI，已证实能解析。

**上游 usage 来源确认（实现时验）**：网关 `build()` 经 `initChatModel` 建的模型 `streamUsage` 默认 true → 流式末帧带 `usage_metadata`；非流式 `invoke()` 结果 `usage_metadata` 同样存在。若某 provider 不报 → usage 缺失，按边界处理（不发 usage 帧，退回当前行为）。

## 数据流（改后，流式）

agent ChatOpenAI 请求网关（streamUsage 默认带 include_usage）→ 网关 `stream()` 调上游模型 → 边转发 content 帧边记 `usage_metadata` → 末尾发 finish 帧 + usage 帧 → agent ChatOpenAI 解析 usage 帧 → 末个 AIMessageChunk 带 `usage_metadata` → graph-runner `flushRound.extractUsage` 命中 → yield usage 事件 → runner 写 `llm_calls` → web token 气泡更新。

## 边界与错误处理

- 上游无 `usage_metadata`（provider 不报）→ 不发 usage 帧 / completion 不加 usage：退回当前行为（气泡 0），不报错、不臆造数字。
- `total_tokens` 缺失 → 用 input+output 兜底。
- usage 帧不影响既有 finish 帧与 `[DONE]`（顺序：content… → finish → usage → [DONE]）。
- 不触碰 `GatewayModelNotFoundError` / deepseek reasoning fetch / role 首帧等既有逻辑。

## 测试

- **单测 `model-gateway.service.spec.ts`**：
  - 非流式：mock `initChatModel` 返回带 `usage_metadata` 的 AIMessage → 断言 `out.usage` = 映射后的 `{prompt_tokens,completion_tokens,total_tokens}`。
  - 流式：mock 上游 stream 末帧带 `usage_metadata` → 断言产出帧里**存在**一个 `choices:[]` 且带 `usage` 的末尾帧，且 usage 数值映射正确；finish 帧仍在。
  - 上游无 usage：断言**不**产出 usage 帧、completion **不**含 usage（回归保护）。
- **端到端眼验**（重启 server-main 后，真实 DeepSeek key）：发消息 → token 气泡显示真实输入/输出/累计、`llm_calls` 有该会话记录、server-agent 日志不再出现 `no usage_metadata`。

## 影响面

- 改：server-main model-gateway（adapter + service + spec）。
- 不改：server-agent / libs/agent、下发逻辑、鉴权/路由、其余 provider 行为。
