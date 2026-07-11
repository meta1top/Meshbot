# 会话级模型选择 设计 spec

> 背景：langchain 1.x S3 后多模型（云 DeepSeek + Ollama 等）真实可用，需要
> 会话粒度的模型选择。分支 `feat/langchain-1x` 连续提交（该功能依赖 S3 的
> 多厂商思考归一，同分支顺延）。

## 0. 需求（用户原话）

1. 前端发起会话时可以选择已有模型；
2. 继续会话时可以随时切换模型；
3. token 用量显示对应的模型。

## 1. 现状勘查结论（地基几乎全在）

| 能力 | 状态 | 位置 |
|---|---|---|
| 会话级模型列 | ✓ | `session.entity.ts:37` `model_config_id`（migration 已含；子 Agent 会话在写，用户会话恒 NULL） |
| per-run 模型覆盖解析 | ✓ 全通 | `runner.service.ts:453` 每次 run `modelRunCtx.run(session?.modelConfigId ?? null, …)` → `model-resolver.service.ts:100-103` override 查 `readModelConfigById` |
| usage 带 model 全链 | ✓ | 事件 schema（`MessageUsageSchema:184`）/ WS（`runner.service:648`）/ llm_calls 落库 / history byMessage / 前端 atom / 气泡组件已渲染 `usage.model` |
| 模型列表 REST + hook | ✓ | `rest/model-config.ts` `useModelConfigs()` |
| 下拉组件模板 | ✓ | `home/composer-target-bar.tsx`（设备选择器，DropdownMenu 受控） |
| 创建会话接收 modelConfigId | ✗ | `CreateSessionSchema` 只有 content+kind |
| 会话中途切换 | ✗ | `PATCH /api/sessions/:id` 路由已在，无 modelConfigId 字段 |
| 选择器 UI | ✗ | 起手台与会话 composer 均无 |
| 用量显示友好名 | ✗ 半 | 气泡显示的 `usage.model` 是云端配置 id 数字串，需映射为 `name` |

## 2. 改动设计（五点）

### 2.1 创建会话带模型

- `libs/types-agent/src/session.ts` `CreateSessionSchema` 加 `modelConfigId: z.string().optional()`
  （DTO `createZodDto` 自动继承）；
- `session.controller.ts` 创建端点透传；
- `session.service.ts` `createSession`/`createSessionInTx` 入参与 `save` 写列
  （照抄 `createSubSessionInTx` 的现成写法）；
- 前端 `rest/session.ts` `createSession(content, kind, modelConfigId?)`。

### 2.2 会话中途切换（PATCH）

- `UpdateSessionSchema`（现 PATCH 用的 schema）加 `modelConfigId: z.string().optional()`；
- `session.service` 更新方法写列（校验该 id 属于当前账号且 enabled——`readModelConfigById`
  已有账号过滤，service 侧查 ModelConfig 存在即可，不存在返回 4xx）；
- **生效语义**：runner 每次 run 重读 `session.modelConfigId` → 下一条消息即用新模型；
  会话历史原样喂新模型；checkpoint/thread 不变；不重跑旧消息。

### 2.3 起手台选择器（新建会话入口）

- `launcher-home.tsx`：模型下拉（照 `composer-target-bar` 的 DropdownMenu 模式，
  数据源 `useModelConfigs()`，展示 `name`），选中 id 随 `createSession` 传入；
- 默认选中列表第一个 enabled（与后端 `readActiveModelConfig` 的隐式默认一致，仅显式化）；
- 模型列表为空时选择器隐藏（auth-guard 已挡「未配模型」状态）。

### 2.4 会话页选择器（切换）

- 会话 composer 区加同款下拉：显示当前会话模型名（`session.modelConfigId` →
  configs 映射；NULL 时显示默认模型名）；切换即 `PATCH /api/sessions/:id
  { modelConfigId }`，成功后本地更新显示；
- 会话详情响应需带 `modelConfigId`（若现有 session DTO 未含则补——实施时核）。

### 2.5 用量友好名

- 气泡（`assistant-message-actions.tsx`）与任何显示 `usage.model` 处：用
  `useModelConfigs()` 做 `model(=云端配置 id) → name` 映射，命不中回退显示原值
  （本地直连时代的历史数据 model 是真模型名，回退即正确）；
- 可复用 `assistant-conversation-body.tsx:72` 已有的映射逻辑（抽公共 helper 优先）。

## 3. V1 边界（YAGNI）

- 只做**本地主会话**（kind=user）；远程会话（L3 relay）与随手问 dock 的选择器后续按需；
- 不做「切模型重跑/重生成旧消息」；regenerate 沿用当时 session 的当前模型；
- 不做 per-message 模型指定（粒度到会话）；
- i18n：新增文案走 next-intl（`sync:locales` 补 stub）。

## 4. 测试与验收

- 单测：CreateSessionSchema/UpdateSessionSchema 解析；session.service 写列与
  PATCH 校验（不存在的 modelConfigId 拒绝）；
- 前端：模型映射 helper 单测（id 命中 / 回退）；
- 眼验（与 S3 思考块眼验合并做）：
  1. 起手台选 Ollama qwen3 → 新会话首条消息气泡显示 qwen3 友好名 + 思考块出现；
  2. 会话中途切 DeepSeek → 下一条消息气泡变 DeepSeek 名 + 思考块仍出（两厂商
     同链路归一的现场证明）；
  3. 不选模型直接发 → 行为与现状一致（默认模型）；
  4. 历史会话（modelConfigId=NULL）不回归。

## 5. 风险

- 极低：解析与 usage 链零改动，全部是「写列 + UI + 映射」；
- PATCH 校验注意账号作用域（ScopedRepository 惯例）；
- `check:repo`/`check:tx` 围栏：session.service 改动涉及单表 update，无需
  @Transactional 变更（单表写不加事务是仓库惯例）。
