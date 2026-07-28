# 会话流系统事件行 + 末尾状态行 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 系统事件（压缩/切模型）作为消息流居中系统行、实时出现；末尾常驻状态行（阶段文案）；压缩↔run 双向并发守卫；删顶部 banner。

**Architecture:** T1（types 契约 + server-agent 事件/落行/守卫）与 T2（StatusLine，web-common）文件集不重叠可并行；T3（SystemEventRow + 实时 append + 删 banner + 禁发，web-common）依赖 T1 事件且与 T2 同文件，串在 T2 后。T4 收尾。

**Tech Stack:** Zod（事件契约）· jotai/socket.io（web-common 流）· jest（web-common）+ vitest 无关 · server-agent jest

**Spec:** `docs/superpowers/specs/2026-07-28-message-stream-system-events-design.md`（逐条为准）

## Global Constraints

- 系统行样式：居中细字 + 两侧 `h-px flex-1 bg-border` 分隔线；压缩行可点开摘要
- 末尾状态行**纯展示不进 timeline**；删除 append `loading-${id}` 假消息的旧机制（use-session-stream 多处），保留 assistant 正文 `streaming` 光标
- `role:"system" + metadata.kind`（`"compaction" | "model_switch"`）；未知 kind 前端安全跳过
- 并发：压缩中拒新 run（kick 前置 `isCompacting`）+ run 中拒压缩（`/compact` 的 `getInflight` 已有）双向对称；前端 compacting 禁发
- 改 DI/新 REST/事件必真 boot（杀 7727）；变异抽查 **sed 定点改 + cp 备份还原，绝不 git checkout**（本轮踩过铁律）
- 中文注释；中文 conventional commits + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>；每任务 `pnpm format`
- 工作分支 `feat/agent-polish`（已建，spec 已在其上）

---

### Task 1: 事件契约 + server-agent（落行/补数据/守卫）（与 T2 并行）

**Files:**
- Modify: `libs/types-agent/src/session.ts`（`RunCompactionDoneEventSchema` 补 `placeholderId/summary/fromMessageId/toMessageId`；新增 `RunSystemEventSchema` + `SESSION_WS_EVENTS.runSystemEvent = "run.system_event"`；HistoryMessage 的 metadata.kind 扩 `"model_switch"`）
- Modify: `apps/server-agent/src/services/session-message.service.ts`（`recordCompactionPlaceholder` 泛化为 `recordSystemEvent({sessionId, id, kind, content, metadata})`，旧方法改薄封装或直接替换调用点，保持幂等）
- Modify: `apps/server-agent/src/services/context-compactor.service.ts`（done 事件 emit 补齐字段：placeholderId=占位行 id / summary / from / to）
- Modify: `apps/server-agent/src/services/session.service.ts:568-596`（patch 里 modelConfigId 变更 → 查新旧 ModelConfig 名 → `recordSystemEvent(kind:"model_switch", content, metadata:{fromModel,toModel})` + emit `run.system_event`）
- Modify: `apps/server-agent/src/services/context-compactor.service.ts`（暴露 `isCompacting(sessionId): boolean` 读 locks map）
- Modify: `apps/server-agent/src/services/runner.service.ts`（`kick`/`kickRetry` 前置 `if (this.contextCompactor.isCompacting(sessionId)) return`——拒新 run；DI 注入 ContextCompactor，注意循环依赖：runner 已被 compactor 用？查依赖方向，若循环用 `forwardRef` 或把 isCompacting 下沉到共享轻量状态）
- Modify: `apps/server-agent/src/ws/session.gateway.ts`（转发 `run.system_event`，对照 compaction 事件转发）
- Test: 相关 service spec 增量（jest）

**Interfaces:**
- Produces: `run.system_event` 事件 `{ sessionId, id, kind, content, metadata }`；`run.compaction_done` 补字段；`recordSystemEvent`；`ContextCompactor.isCompacting`

- [ ] **Step 1: 契约先行**　types-agent 加事件/字段/kind，两端 typecheck 先暴露所有消费点
- [ ] **Step 2: 失败测试**（jest）：patch 切模型落 system+model_switch 行 + emit 事件；compaction done 带 4 字段；isCompacting 反映 locks；kick 在 isCompacting 时 no-op（拒 run）；recordSystemEvent 幂等（同 id 不重插）+ compaction 路径回归
- [ ] **Step 3: 实现**（循环依赖：先 grep ContextCompactor 与 RunnerService 的现有依赖方向——compactor 不依赖 runner 则 runner 注入 compactor 无环；有环则 isCompacting 走 forwardRef 或独立 InflightState 服务）
- [ ] **Step 4: boot + 提交**　`pnpm build:server-agent && timeout 60 node dist/main.js`（杀 7727）；commit `feat(agent): 系统事件行契约与落行——compaction 补数据/切模型落行/压缩并发守卫`

---

### Task 2: StatusLine 末尾状态行（web-common，与 T1 并行）

**Files:**
- Create: `packages/web-common/src/session/status-line.tsx`
- Modify: `packages/web-common/src/session/message-list.tsx`（末尾渲染 StatusLine；删 `m.loading` 相关分支）
- Modify: `packages/web-common/src/session/use-session-stream.ts`（删 append `loading-${id}` 假消息机制 + 各处 `filter(!m.loading)`；`compacting`/`running`/最后消息状态派生给 StatusLine）
- Modify: `packages/web-common/src/session/timeline.ts`（删 `loading` 字段）
- Modify: `packages/web-common/src/session/session-conversation-view.tsx`（StatusLine 接线，传 running/compacting/阶段信号）
- Test: `status-line.spec.tsx`（阶段文案派生五态）

**Interfaces:**
- Produces: `StatusLine({ phase: "thinking"|"executing"|"streaming"|"compacting"|null })`；phase 由调用方从 running/compacting/最后 assistant 消息状态派生

- [ ] **Step 1: 失败测试**（阶段→文案映射；phase=null 不渲染；文案轮换用假定时器测切换）
- [ ] **Step 2: 实现 StatusLine**（三点动画复用 TypingDots 视觉；阶段文案见 spec §三；同阶段轻量轮换纯前端 setInterval ~3s，reduced-motion 停轮换）
- [ ] **Step 3: 收敛 loading 机制**（删假消息 append + filter；派生 phase：compacting>工具运行>思考>流式>兜底 thinking；`m.loading` 字段与消费点全删，typecheck 兜底找残留）
- [ ] **Step 4: 提交**　`pnpm format && pnpm typecheck && pnpm --filter @meshbot/web-common test`；commit `feat(web-common): 消息流末尾常驻状态行——阶段文案替代绑定假消息的 TypingDots`

---

### Task 3: SystemEventRow + 实时 append + 删 banner + 禁发（web-common，依赖 T1/T2）

**Files:**
- Create: `packages/web-common/src/session/system-event-row.tsx`（居中细字分隔线；compaction 可展开）
- Delete: `packages/web-common/src/session/compaction-banner.tsx` + `compaction-row.tsx`（职责并入）
- Modify: `packages/web-common/src/session/message-list.tsx`（`role==="system" && metadata?.kind` → SystemEventRow，按 kind 分文案；删 CompactionRow 分支）
- Modify: `packages/web-common/src/session/use-session-stream.ts`（`onCompactionDone` 改：补数据直接 append system+compaction timeline 消息（幂等）；新增 `onSystemEvent` 订阅 `run.system_event` → append；`onCompactionStart` 只留 setCompacting 驱动禁发/状态行，删 banner 相关）
- Modify: `packages/web-common/src/session/session-conversation-view.tsx`（删 CompactionBanner 渲染）
- Modify: web-agent ChatInput 接线处（`compacting` 为真禁发——找 assistant-conversation-body 传 ChatInput 的 isLoading/disabled，或 running||compacting）
- Modify: `libs/types-agent` 若前端要事件类型 + i18n 文案 key（system 行 compaction/model_switch 文案，zh/en）
- Test: `system-event-row.spec.tsx`（kind 分支）；use-session-stream append 幂等用例

**Interfaces:**
- Consumes: T1 的 `run.compaction_done`（补字段）/ `run.system_event`；T2 的 StatusLine（禁发时显压缩中）

- [x] **Step 1: 失败测试**（SystemEventRow 三分支渲染；compaction_done append 幂等；system_event append；未知 kind 跳过）
- [x] **Step 2: 实现 SystemEventRow + append**（compaction_done/system_event 两路 append 复用同一 `appendSystemEventToTimeline(id, kind, content, metadata)`，同 id 已在则跳过）
- [x] **Step 3: 删 banner + 禁发 + StatusLine 接线**（CompactionBanner/CompactionRow 删除，grep 消费方清净；compacting 禁发接线；**T2 遗留：给 web-agent `assistant-conversation-body.tsx` 的 labels 对象补 `statusLine` i18n 字段**——否则末尾状态行永不可见、T4 无法验收；system 行 compaction/model_switch 文案 + statusLine 五态文案一并加 zh/en，`sync:locales -- --check`）
- [x] **Step 4: 提交**　`pnpm format && pnpm typecheck && pnpm sync:locales -- --check && pnpm --filter @meshbot/web-common test`；commit `feat(web-common): 系统事件行（居中分隔线）实时出现 + 删顶部 banner + 压缩中禁发`

---

### Task 4: 收尾验收

- [ ] **Step 1: 全量围栏**　`pnpm lint && pnpm typecheck && pnpm check && pnpm sync:locales -- --check && pnpm test && pnpm build`（web-agent build 后删 .next 留 out）
- [ ] **Step 2: 变异抽查 ×2（sed+cp 备份，勿 git checkout）**：①kick 的 isCompacting 守卫条件取反 → 守卫用例红；②StatusLine 的 compacting 阶段判定取反 → 阶段用例红。两头 grep 实证
- [ ] **Step 3: 真机验收清单（交用户）**
  - 长对话 `/compact`：压缩中末尾状态行显「正在压缩会话历史」→ 完成后居中系统行「已压缩 N 条」**实时出现**（不重进会话）；可点开摘要
  - 切换模型 → 消息流落一行「已切换模型 A → B」
  - 压缩中发送被禁（按钮禁用）；压缩完自动恢复；压缩中第二台设备/并发 kick 也被后端拒
  - 末尾状态行阶段文案随真实状态变（思考/执行/处理/压缩），run 结束即消失，无幽灵残留
  - 回归：普通流式、reasoning 计时、工具卡、pending 区、滚到底按钮不受影响

---

## Self-Review 记录

- Spec 覆盖：§三 StatusLine→T2；§四 SystemEventRow+实时+切模型→T1/T3；§五并发守卫→T1；§六契约→T1；§七测试→各任务+T4。banner 删除→T3。
- 占位符：循环依赖处置给了判断路径（grep 依赖方向 + forwardRef/独立状态兜底）；loading 消费点删除靠 typecheck 兜底找残留。
- 类型一致性：`recordSystemEvent`/`isCompacting`/`run.system_event`/`appendSystemEventToTimeline`/`phase` 各自定义与消费一致；metadata.kind 枚举前后端共享。
- 任务图：T1 ∥ T2 → T3 → T4。
