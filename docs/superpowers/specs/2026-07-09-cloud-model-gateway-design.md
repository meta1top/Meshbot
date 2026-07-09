# 云端模型网关（OpenAI 兼容代理）设计

日期：2026-07-09
状态：设计已确认，待写实施计划

## 背景

meshbot 是本地优先 + 云端协同的双形态 AI Agent 平台。当前模型配置已「云端化」，但**方向与安全目标相反**：

- 云端 `OrgModelConfig`（Postgres）用 AES-256-GCM 加密存厂商 apiKey（`libs/main/src/entities/org-model-config.entity.ts:18`，`apiKeyEnc`）。
- 下发端点 `GET /api/agent/model-configs`（`apps/server-main/src/rest/agent-config.controller.ts` → `OrgModelConfigService.listForAgent`，`libs/main/src/services/org-model-config.service.ts:76-90`）**解密后以明文返回**厂商 apiKey。
- server-agent 把明文写进本地 SQLite `model_configs.api_key`（`source='cloud'`，`apps/server-agent/src/entities/model-config.entity.ts:18`）。
- libs/agent 直接从 SQLite 读明文 apiKey 交给 LangChain（`libs/agent/src/config/model-config.reader.ts:30`）。

即厂商 apiKey 明文缓存在每台设备上——桌面端本地存厂商 key 是泄漏面。

## 目标

在云端集中配置各厂商模型，由 server-main 提供一个 **OpenAI 兼容接口**，本地 AI 用 OpenAI SDK（经现有 `openai-compatible` provider）调用，鉴权用**用户登录态（device token）**。厂商 apiKey **只在云端解密使用，绝不下发端侧**。

## 核心决策

1. **混合路由**：仅 `source='cloud'` 的厂商模型走云端网关；本地 / ollama / 自托管模型仍端侧直连（保留 local-first 退路，只对需要保密 key 的模型强制过网关）。
2. **网关引擎复用 langchain `initChatModel`**（Node）：网关 = 包在 `initChatModel` 外的 OpenAI 兼容 HTTP 壳，与 libs/agent 同一套 provider 抽象、行为一致、全厂商开箱、不引新语言/运行时。
3. **网关位置 = server-main 内新增 NestJS 模块**（最快落地，复用其 Nest app / guard / `OrgModelConfigService` / crypto）。取舍：给「纯元数据」定位的 server-main 引入 langchain + 出站 LLM 调用 + 长连流式，轻微超出双轨划分——已接受。
4. **v1 纯代理**：鉴权 + 解密 + 调厂商 + SSE 流式转发。**不做**用量记录 / 限流 / 配额（本地已有 `LlmCall` 记用量；集中计量另起一期）。

## 架构与数据流

```
libs/agent · createChatModel（source='cloud' 行）
  openai-compatible client → baseURL = <MESHBOT_CLOUD_URL>/v1
  fetch 包装：每请求注入 Authorization: Bearer <device token>
  body.model = <OrgModelConfig.id>
      │  POST /v1/chat/completions
      ▼
server-main · ModelGatewayModule
  1) JwtAuthGuard 验 device token → { userId, orgId, deviceId }
  2) body.model(=id) + orgId 查 OrgModelConfig（校验归属，跨 org → 403）
  3) SecretCryptoService.decrypt(apiKeyEnc) → 明文厂商 key（仅内存）
  4) initChatModel(真实 providerType, { model 真名, baseUrl, apiKey })
  5) 调厂商，chunk 转 OpenAI SSE 帧流式回端侧
```

## 组件设计

### 网关模块（server-main 新增）

- `ChatCompletionsController` — `POST /v1/chat/completions`，挂全局 `JwtAuthGuard`（`apps/server-main/src/auth/jwt-auth.guard.ts` 已能同时吃 device token 与用户 JWT，解出 `{userId, orgId, deviceId}`）。支持 `stream: true/false`。
- `ModelGatewayService` — 编排：解析模型 → 解密 → `initChatModel` → 转发。
  - OpenAI 请求体（messages / tools / tool_choice / temperature 等）转 langchain 输入。
  - langchain 流转 OpenAI `chat.completion.chunk` SSE 帧（含 tool_calls 增量）。
  - 非流式：聚合为 `chat.completion`。
- 复用现成域件：`OrgModelConfigService`（新增 `resolveDecrypted(orgId, modelId)`：查归属 + 解密，供网关内部用；不经现有 `listForAgent`）、`SecretCryptoService`、`JwtAuthGuard`。
- 新增依赖：server-main 引入 langchain 及各 provider 包，版本与 libs/agent 对齐。

### 端侧改动（下发链反转）

- **下发反转**：`GET /api/agent/model-configs` 不再解密明文 key，改为返回**不含厂商 key** 的配置：`{ id, name, model=id, contextWindow, enabled }`。`AgentModelConfig.apiKey`（`libs/types/src/model-config/model-config.types.ts:35-44`）语义作废。
- **端侧存储**：`ModelConfigSyncService.replaceCloudConfigs`（`apps/server-agent/src/services/model-config-sync.service.ts`）写的 `source='cloud'` 行改为：`providerType='openai-compatible'`、`baseUrl=<gateway>/v1`、`model=<OrgModelConfig.id>`、`apiKey` 存占位（不再是厂商明文）。真实 provider / model 名只在云端持有。
- **动态 token 注入**：`createChatModel`（`libs/agent/src/graph/llm.factory.ts:126`）对云模型用 **fetch 包装**（复刻现有 `patchedFetchForDeepseek` 模式）在每请求注入当前 device token 作 Bearer；`ModelResolver` 缓存 key（`model-resolver.service.ts` 现为 `provider|model|baseUrl|apiKey`）对云模型**排除 token**，避免 token 轮换后命中旧 client。401 → 复用 `CloudClientService`（`apps/server-agent/src/cloud/cloud-client.service.ts:93-101`）现有清 token + 重授权链路。

## 关键实现细节

### 模型标识与归属校验

端侧 OpenAI `model` 字段 = `OrgModelConfig.id`（稳定唯一）。网关按当前身份 `orgId` 查该 id，归属不符直接 403，杜绝跨 org 取模型。端侧「选哪个云模型」仍沿用 `readActiveModelConfig` 的 `enabled=1 ORDER BY created_at LIMIT 1`（`model-config.reader.ts:31-32`），只是选出的行现在指向网关。

### 鉴权与安全

- 端侧用 `CloudIdentity.deviceToken`（`apps/server-agent/src/entities/cloud-identity.entity.ts:30`，当前主力凭据）作 `Authorization: Bearer`（即 OpenAI apiKey 位）。
- 厂商 key 仅在网关内存解密后立即用于 `initChatModel`，不落端侧、不进日志、不入响应。
- 端侧本地 SQLite 的 `source='cloud'` 行不再含厂商明文（安全提升的核心）。

### DeepSeek thinking 处理（风险点）

DeepSeek 的 `reasoning_content` 往返处理现分散在端侧（`llm.factory.ts:140` fetch 补丁 + `supervisor.node.ts:52` 剥离）。deepseek 走网关后，端侧看到的是 `openai-compatible` 不再是 `deepseek`，这套处理需挪到网关侧（网关内 `initChatModel(deepseek)` 时应用）。其他 provider（openai / anthropic 原生 / google）无此问题。

**开放选项**：若云端主要用 openai / anthropic，可把「deepseek 经网关」降级为暂不支持（deepseek 仍作为 `source='local'` 直连），进一步简化 v1。默认：网关侧处理。

## 已知限制

- 云端成为**云模型**推理硬依赖（断网 / 云端挂 → 云模型不可用；local/ollama 留退路）。已接受。
- OpenAI 兼容边界不暴露厂商原生特性（如 Anthropic prompt caching / 扩展思考）。**核实：libs/agent 当前不依赖这些**（无 `cache_control` / `anthropic-beta` / 扩展思考；`thinking` 均为 deepseek），故损失极小。
- server-main 引入 langchain + 出站调用，轻微超「纯元数据」定位。已接受。

## 非目标（v1 不做）

- 用量记录 / 计费 / 配额 / 限流。
- 网关侧审计日志。
- 端侧对网关不可达的降级缓存（混合路由已用 local 模型兜底，不做云模型的本地回退）。

## 测试策略

- **网关单测**：鉴权（有效 / 无效 / 跨 org 403）、`resolveDecrypted` 归属 + 解密、流式 SSE、非流式聚合、工具调用透传、厂商错误透传。
- **端侧单测**：云模型经 mock 网关的调用、device token 轮换后动态注入、local 模型仍直连不受影响、下发反转后端侧不再落厂商明文。
- **e2e（server-main，含 Postgres service）**：`/v1/chat/completions` 鉴权 + 归属 + 转发（mock 厂商出站）。

## 主要涉及文件

新增（server-main）：`ModelGatewayModule` / `ChatCompletionsController` / `ModelGatewayService`。
修改（server-main / libs/main）：`OrgModelConfigService`（加 `resolveDecrypted`）、`agent-config.controller.ts` + `listForAgent`（去明文下发）、`AgentModelConfig` 类型。
修改（server-agent / libs/agent）：`model-config-sync.service.ts`（写网关坐标行）、`model-config.entity` / `model-config.reader`（cloud 行不存厂商 key）、`llm.factory.ts` + `model-resolver.service.ts`（动态 token 注入 + 缓存 key 排除 token）。
