# 会话级模型选择 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 起手台选模型创建会话、会话中 PATCH 切换（下一条消息生效）、token 气泡显示模型友好名。

**Architecture:** 后端只是「字段透传 + 写列」（override 解析链与 usage 链全部现成）；前端两个下拉（照 composer-target-bar 模板）+ 一个 id→name 映射 helper。

**Tech Stack:** Zod schema / NestJS DTO(createZodDto) / Next.js + jotai + @meshbot/design DropdownMenu / next-intl

## Global Constraints

- 分支 `feat/langchain-1x` 主仓，连续提交不切 PR。
- 后端解析链（runner/model-resolver/ModelRunContext）与 usage 链**零改动**。
- 前端新增用户可见文案一律 next-intl（改完跑 `pnpm sync:locales -- --write` 补 stub）。
- 单表 update 不加 @Transactional（仓库惯例）；session.service 改动过 `check:tx/naming/repo` 围栏。
- V1 只做本地主会话；remote 会话/随手问 dock 不做。

---

## Task 1: 后端字段透传（创建 + PATCH + 校验）

**Files:**
- Modify: `libs/types-agent/src/session.ts`（CreateSessionSchema / PATCH 所用 schema）
- Modify: `apps/server-agent/src/controllers/session.controller.ts`（创建与 PATCH 端点透传）
- Modify: `apps/server-agent/src/services/session.service.ts`（createSessionInTx 写列；update 校验+写列）
- Test: `apps/server-agent/src/services/session.service.spec.ts` 加用例

**Interfaces:**
- Produces: `CreateSessionSchema.modelConfigId?: string`；PATCH schema 同名字段；
  `SessionService.createSession` 入参对象加 `modelConfigId?`；update 方法接受并校验。

- [ ] **Step 1**: `CreateSessionSchema` 与 PATCH schema（session.ts 里找现 PATCH 用的
  schema——`UpdateSessionSchema`/`RenameSessionSchema` 之类，以 controller PATCH 端点
  实际引用为准）各加 `modelConfigId: z.string().optional()`，带中文 JSDoc。
- [ ] **Step 2**: 先写失败单测：
  - createSession 传 modelConfigId → session 行落列；不传 → NULL（现状）；
  - update 传合法 id → 列更新；传不存在的 id → 抛（4xx 语义的业务异常，照
    service 现有错误风格）。校验用 ModelConfig 按账号查存在性（走归属 Service，
    禁直注 Repository——check:repo）。
- [ ] **Step 3**: 实现：createSessionInTx 照抄 `createSubSessionInTx` 写列；update
  校验 + 写列；controller 两端点透传 dto 字段。
- [ ] **Step 4**: `npx jest apps/server-agent/src/services/session.service.spec.ts` 绿；
  `pnpm typecheck`、`pnpm check` 绿。
- [ ] **Step 5**: commit `feat(server-agent): 会话创建与 PATCH 支持 modelConfigId（会话级模型选择后端）`。

---

## Task 2: 前端两个选择器 + 友好名映射

**Files:**
- Create: `apps/web-agent/src/components/common/model-select.tsx`（受控下拉，复用于两处）
- Create/Modify: 模型名映射 helper（勘查见 `assistant-conversation-body.tsx:72` 已有
  类似逻辑——抽成 `lib/model-name.ts` 公共 helper 并两处复用）
- Modify: `apps/web-agent/src/components/home/launcher-home.tsx`（起手台接入 + createSession 带参）
- Modify: 会话页 composer 区（以 `assistant-conversation-body.tsx` 或其 composer 容器为准，实施时读）
- Modify: `apps/web-agent/src/rest/session.ts`（createSession 加参；PATCH 调用）
- Modify: `apps/web-agent/src/components/session/assistant-message-actions.tsx`（usage.model → 友好名）
- Modify: `apps/web-agent/messages/{zh,en}.json`（sync:locales）

**Interfaces:**
- Produces: `<ModelSelect value onChange configs />`（展示 name，受控）；
  `resolveModelName(configs, usageModel): string`（命不中回退原值）。

- [ ] **Step 1**: 抽 `resolveModelName` helper + 单测（命中 id→name / 回退原值）。
- [ ] **Step 2**: `ModelSelect` 组件（照 `composer-target-bar.tsx` 的 DropdownMenu
  模式；数据 `useModelConfigs()`；空列表返回 null）。
- [ ] **Step 3**: 起手台接入：state 默认第一个 enabled；`handleSend` 把选中 id 传
  `createSession`；`rest/session.ts` 签名与 body 扩展。
- [ ] **Step 4**: 会话页接入：显示当前 `session.modelConfigId` 名（NULL → 默认模型名）；
  切换调 PATCH（`rest/session.ts` 加 `updateSessionModel(sessionId, modelConfigId)`），
  成功后更新本地 state。会话详情缺 modelConfigId 字段则后端 history/session DTO 补
  （回 Task 1 加一行）。
- [ ] **Step 5**: 气泡友好名：`assistant-message-actions.tsx` 用 helper 映射
  `usage.model`；`assistant-conversation-body.tsx:72` 原逻辑改用同一 helper。
- [ ] **Step 6**: i18n：新文案 t() + `pnpm sync:locales -- --write`。
- [ ] **Step 7**: `pnpm --filter @meshbot/web-agent typecheck`、helper 单测绿、
  `pnpm check` 绿；commit `feat(web-agent): 会话级模型选择器 + 用量气泡模型友好名`。

---

## Task 3: 合并眼验（本功能 + S3 思考块，一场做完）

前置：server-agent / web-agent dev 在跑（本功能是 watch 热更范围）；server-main
已是 S3 版本（已重建）；org 配好 DeepSeek reasoner + Ollama qwen3 两个模型且已下发。

- [ ] 起手台模型下拉出现、默认选中第一个模型
- [ ] 选 **Ollama qwen3** 新建会话发问 →（S3）思考块流式展开 →（本功能）气泡显示 qwen3 友好名
- [ ] 会话中途切 **DeepSeek reasoner** → 下一条消息：思考块仍出、气泡变 DeepSeek 名
  ——两厂商同链路归一的现场证明
- [ ] 不选模型直接发 → 行为与现状一致（默认模型）
- [ ] 历史会话（modelConfigId=NULL）打开/继续不回归
- [ ] 刷新页面：思考块还在（S3 落库）、气泡模型名还在（history byMessage）
- [ ] 通过后：S3 与本功能一并收官记录（plan 回归结论 + 账本 + 记忆）

## 回归结论

<!-- 眼验通过后填写 -->
