# 会话流系统事件行 + 末尾状态行设计

日期：2026-07-28
范围：`packages/web-common/src/session/`（渲染层）+ `apps/server-agent`（compaction_done 事件补数据、切模型落系统行、并发守卫）+ `libs/types-agent`（事件契约 + metadata.kind 扩展）
参照：Claude Code / Claude VS Code 插件的消息流呈现（系统事件作为时间线一行、末尾常驻 loading）

## 一、背景与动机

真机验收 `/compact` 时发现压缩全程 UI 无反馈。根因排查出三层问题，且触及更本质的呈现范式缺口：

1. **顶部 CompactionBanner 长对话不可见**：banner 渲染在滚动内容顶部，用户滚在底部时永远看不到（`session-conversation-view.tsx:188`）。
2. **压缩占位行落库后不实时出现**：`run.compaction_done` 只撤 banner、不重拉 history，占位行要等重进会话才显示（`use-session-stream.ts:1242` 注释自陈的 v1 限制）。
3. **压缩期间可并发发消息**：无守卫，新 run 与压缩的 checkpoint 改写并发 → 消息序错乱/tool 配对断裂（与 `/compact` 已加的「run 中禁压缩」守卫是同一类竞态的反向未堵面）。

用户提出对齐 Claude Code 的两个范式：**①系统事件（压缩/切模型）作为消息流里无发送人的居中提示行**；**②消息流末尾常驻 loading 行**（思考中/执行中/处理中/压缩中 按阶段轮换，结束即消失）。

现状代码里各有半成品：`CompactionRow`（左对齐竖线占位行，非居中、不实时）是系统行雏形；`TypingDots`（绑在 assistant 占位消息上、单一文案）是末尾 loading 雏形。本设计把两者收敛为通用范式。

## 二、已确认的决策

| 决策点 | 结论 |
|--------|------|
| 范围 | 系统事件行 + 末尾 loading 行**两项都做** |
| 系统行样式 | **居中细字 + 两侧淡分隔线**（`── 文案 ──`），压缩行可点击展开摘要 |
| 压缩并发 | **压缩中禁发**（前端发送禁用 + 末尾 loading 显「压缩中」）+ 后端对称守卫（压缩中拒新 run）|
| 顶部 banner | **删除**（职责由末尾 loading「压缩中」+ 完成后系统行接管）|

## 三、末尾状态行（StatusLine）

- 新 `StatusLine`（`packages/web-common/src/session/status-line.tsx`）：`running || compacting` 为真时，消息流**末尾恒渲染一行**——三点动画 + 阶段文案。**纯展示、不进 timeline 数组**（不再往 timeline 塞 `loading-${id}` 假消息）。
- **阶段文案（反映真实状态，非纯随机）**：
  - `compacting` → 「正在压缩会话历史…」
  - 最后一条 assistant 有 running 工具卡 → 「正在执行…」
  - reasoning 思考中 → 「思考中…」
  - 流式产出中 → 「处理中…」
  - 兜底（run 刚起、尚无信号）→ 「思考中…」
  - 同阶段可轻微文字轮换（如「思考中…」每 ~3s 在「思考中/组织语言中/整理思路中」间换）避免呆板——轮换是纯前端定时，不依赖后端信号。
- **收敛现有机制**：删除 `migrateHumanToTimeline` 里 append `loading-${id}` 占位 assistant 消息的逻辑及其各处 `filter(m => !m.loading)` 清除；`streaming` 光标机制保留（那是 assistant 正文自身的流式渲染，与末尾 loading 不同层）。`timeline.ts` 的 `loading` 字段清理。
- StatusLine 位置：MessageList 渲染列表之后、pending 区之前，随内容自然滚动（用户在底部时可见；不在底部有「滚到底」按钮已有）。

## 四、系统事件行（SystemEventRow）

- 新 `SystemEventRow`（`packages/web-common/src/session/system-event-row.tsx`）：一行居中极小灰字，两侧 `flex-1` 淡分隔线（`h-px bg-border`）。压缩类带 removedCount 且可点击展开 summary（复用 CompactionRow 的展开逻辑，换居中壳）。`CompactionRow` 删除或并入。
- **数据模型（复用 role:"system" + metadata.kind）**：
  - `metadata.kind = "compaction"`（现有）：文案「已压缩 N 条早期消息」+ 可展开摘要
  - `metadata.kind = "model_switch"`（新增）：文案「已切换模型：{oldName} → {newName}」，metadata 存 `{ fromModel, toModel }`
  - MessageList 的 compaction 分支泛化为「`role==="system" && metadata?.kind` → `SystemEventRow`」，按 kind 分文案；未知 kind 安全跳过（向后兼容未来新 kind）
- **压缩行实时出现（修 v1 限制）**：`run.compaction_done` 事件**补齐占位行完整数据**（`placeholderId` / `summary` / `removedCount` / `fromMessageId` / `toMessageId`）；前端 `onCompactionDone` 收到后**直接 append 一条 system+compaction timeline 消息**（若该 id 尚不在 timeline），不再依赖重拉 history。
- **切模型落系统行**：
  - 后端 `session.service.patch()`：modelConfigId 变更时，除更新字段外，写一条 `role:"system" + kind:"model_switch"`（新旧模型名从 ModelConfig 查），并 emit 新 WS 事件 `run.system_event`（带完整行数据）
  - 通用服务方法：`recordCompactionPlaceholder` 泛化为 `recordSystemEvent({ sessionId, kind, content, metadata })`（compaction 路径改调它，保持幂等）
  - 前端订阅 `run.system_event` → append 进 timeline（与 compaction_done 同款 append 逻辑，复用）
  - 注意：切模型是纯 session 字段 PATCH，本无 run——落行 + emit 走 PATCH 同步路径即可，不经 runner

## 五、并发守卫（压缩 ↔ run 双向）

- 后端 `ContextCompactor` 暴露 `isCompacting(sessionId): boolean`（读 `locks` map 有无该 session 的在途 Promise）
- `RunnerService` kick 路径（`kick*` → `consumeRunStream`）前置检查 `contextCompactor.isCompacting(sessionId)`——为真则拒绝新 run（抛/返 409「会话压缩中，请稍候」，前端提示）。与 `/compact` 端点已有的 `getInflight` 守卫（run 中禁压缩）**双向对称**，彻底堵住 checkpoint 竞态
- 前端：`compacting` 为真时 ChatInput 发送禁用（复用 `running` 的禁用/隐藏发送逻辑）；末尾 StatusLine 显「压缩中」

## 六、事件契约变更（libs/types-agent）

- `run.compaction_done` payload 增字段：`placeholderId` / `summary` / `removedCount` / `fromMessageId` / `toMessageId`（现仅 sessionId）
- 新增 `run.system_event` 事件：`{ sessionId, id, kind, content, metadata }`（切模型等通用系统行的实时下发）
- `metadata.kind` 枚举扩展：`"compaction" | "model_switch"`（HistoryMessage 契约同步）

## 七、测试与验收

风险分档：**中-高**（后端并发守卫 + WS 事件契约 + 消息流渲染管线改动）。实施 + 独立审查 + 变异（不派全分支终审，随分支 PR 前终审一并）。

- 单测：
  - `StatusLine` 阶段文案派生（compacting/工具运行/思考/流式/兜底五态）
  - `SystemEventRow` 按 kind 渲染（compaction 可展开 / model_switch 文案 / 未知 kind 跳过）
  - `onCompactionDone` / `onSystemEvent` 实时 append（幂等：同 id 不重复插）
  - 后端 `recordSystemEvent` 泛化（compaction 幂等回归 + model_switch 落行）
  - 双向并发守卫：isCompacting 为真时 kick 拒绝；getInflight 为真时 compact 拒绝（已有，回归）
  - 变异：并发守卫条件取反 → 用例红
- 真机验收清单：
  - 长对话 `/compact` 全程可见：压缩中末尾 loading 显「压缩中」→ 完成后系统事件行**实时出现**在流里（不用重进会话）
  - 切换模型 → 消息流落一行「已切换模型 A → B」
  - 压缩中发送被禁（按钮禁用 + loading 提示）；压缩完自动恢复
  - 末尾 loading 行阶段文案正确（思考/执行/处理/压缩），run 结束即消失，无幽灵 loading 残留
  - 回归：普通对话流式、reasoning「已思考 N.Ns」、工具卡、pending 区不受影响
- `pnpm lint / typecheck / check / test / build` 全绿

## 八、明确不做

- 系统行的第三类事件（如「已清空记忆」等）——本期只压缩 + 切模型，kind 机制预留
- loading 文案的 i18n 之外的可配置化
- 压缩中发送「排队」方案（选了禁发，不做 pending 队列 + 压缩后出队）
- 移动端 / web-main 远程会话的系统行（远程只读，随现有 history 装配自然显示，不新增实时事件订阅）
