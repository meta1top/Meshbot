# 派子 Agent Phase 2（后台派发 + model 覆盖）设计

## 1. 背景与目标

Phase 1a（PR #8）落地前台阻塞派发，Phase 1b（PR #9）落地前端嵌套实时卡。`dispatchSubagentSchema` 自 1a 起就含 `model`/`background` 字段但**只接收不生效**。Phase 2 让它们生效：

1. **`background:true` 后台运行**：dispatch 立即返回句柄，父 run 不阻塞、用户可继续对话；子 Agent 独立生命周期跑完。
2. **完成回灌播报**：子完成/失败/中止后，往父会话注入播报消息并 kick 主 Agent 新 run 汇报（照 schedule-executor 先例：可见 user 气泡）。
3. **嵌套卡停止按钮 / 独立 abort**：卡上停止子 run（前台停→父收 aborted 续跑；后台停→播报「已中止」）。
4. **model per-run 覆盖**：dispatch 可指定 ModelConfig（id/名），子 run 用指定模型；缺省继承当前启用模型。
5. **重启恢复**：进程重启后后台孤儿任务续跑、宕机窗口丢失的播报补发。

## 2. 关键决策（已确认）

| 决策点 | 结论 |
|---|---|
| 范围 | 四件全做 + 重启恢复（后台任务不做重启恢复等于半成品） |
| 播报形态 | **可见 user 气泡**，照 `schedule-executor.service.ts` 先例（`appendMessage` + `kick`），零前端改动 |
| model 覆盖锚点 | **持久化到 Session（`model_config_id` 列）+ ALS 覆盖解析**；重启恢复天然带覆盖；顺路修 usage meta 共享字段的标错风险 |

## 3. 数据模型（一次迁移，两列）

`sessions` 加列（迁移 `AddSessionBackgroundAndModel`）：
- `background`（integer NOT NULL DEFAULT 0）——语义：**「有待了结的后台子任务」**。建后台子会话时置 1，播报完成（或确认无需播报）置 0。天然充当重启恢复的扫描标记。
- `model_config_id`（text NULL）——dispatch 解析成功的 ModelConfig id；非 subagent 会话恒 NULL。

`dispatchSubagentSchema` 不变（1a 已含字段）。`Session` Entity 同步加字段；归属不变（SessionService 唯一持有）。

## 4. 后台分支（DispatchSubagentService）

与前台共用：守卫（父存在且非 subagent）、信号量（**后台占槽至子 run 结束**，前台+后台合计上限 `SUBAGENT_MAX_CONCURRENCY=4`）、`createSubSession`、`runSubagentSpawned` 事件。

后台差异：
1. 建子会话时写 `background=1`（及 `model_config_id`，见 §6）。
2. **立即返回** `JSON {subSessionId, status:"running"}`——父 LLM 拿句柄继续本轮。
3. **不挂父 signal**（独立生命周期，父 run stop 不杀它）；入口 `signal.aborted` 检查保留（派发前父已停则不建）。
4. **fire-and-forget 续接**（`settleBackground(subSessionId)`，同一函数供重启恢复复用）：
   - `runner.kickAndWait(subSessionId)` 跑到完成；
   - 读终态（复用 1a 的 `hasFailedPending` / `findLastAssistant`）→ `status ∈ done|error|aborted`，判定表：有 failed pending → `error`；有非 failed 的活跃 pending（中断后遗留）→ `aborted`；无活跃 pending → `done`（`findLastAssistant` 为 null 时同 1a 规则记 `error`）。（**现场核对点**：`aborted` 分支依赖「`runner.interrupt` 后被中断的消息回滚为 pending」这一 runner 现状行为，plan 阶段按 `runner.service.ts` 中断路径实况核实；若中断后 pending 被标 failed，则 aborted 需改由 interrupt 侧留痕判定。）
   - **完成回灌**：`sessions.appendMessage(parentSessionId, 播报文本)` + `runner.kick(parentSessionId)`。播报文本：`子任务「<description>」已完成/失败/已中止。结果：<capForLlm 截断的 output>`；
   - **重写父会话 tool 行**：把该 `parentToolCallId` 的 `role=tool` 行 content 更新为终态 JSON `{subSessionId, status, output}`（新方法 `SessionMessageService.updateToolResult(toolCallId, content)`；只动 session_messages 这份 UI 副本，checkpointer/父 LLM 上下文不受影响——刷新后嵌套卡能显示终态）；
   - 发 **`run.subagent_settled`** 事件到父房间（新事件，types-agent 定义 + gateway 转发，payload `{sessionId, toolCallId, subSessionId, status, output}`，对称 1b 的 spawned）；
   - `background=0`；
   - `finally` 释放信号量槽。
5. 错误路径：播报 `appendMessage` 失败 → 重试一次，仍失败记日志放弃（`background` 保持 1，下次重启补发）；父会话已删 → 跳过播报与 tool 行重写，直接置 0。

前台分支不变（1a 语义），不发 settled（`tool_call_end` 已带终态 result）。

## 5. 重启恢复

server-agent 启动钩子（DispatchSubagentService `onApplicationBootstrap`，在迁移与模块装配后）：扫描 `kind='subagent' AND background=1`（系统级 unscoped 查询 + 按 `findOwner` 建账号上下文，照 schedule-executor 的 boot 模式）：
- **有活跃 pending**（宕机时没跑完；启动时既有 `rollbackProcessingToPending` 已把 processing 滚回 pending）→ `settleBackground(subSessionId)`（内含 kickAndWait 续跑 + 播报）；
- **无活跃 pending**（跑完了但播报丢在宕机窗口）→ 跳过 kick，直接走 settle 的读终态+播报段。

两分支即 `settleBackground` 的自然行为（kickAndWait 对无 pending 的会话是 no-op 返回），无需分叉实现。恢复任务同样过信号量。

## 6. model per-run 覆盖

- **解析**：dispatch 收到 `model` 时按 **id 或 name** 查 `ModelConfigService`（含未启用的配置也可指定；查不到 → 立即返回 `{subSessionId:"", status:"error", output:"未找到模型配置 <model>…"}`，让主 LLM 改参重试）。解析成功把 id 写入子会话 `model_config_id`。
- **生效**：`RunnerService` 起 run 前读 session（既有 `findOrNull`，已在 `consumeRunStream` 读过 kind——同一次读取顺带拿 `modelConfigId`），有值则用 **ALS 覆盖上下文**（libs/agent 新增 `ModelOverrideContext`，AsyncLocalStorage 模式同 `AccountContextService`）包裹 run；`ModelResolver.resolveModel()` 优先按覆盖 id 读配置（`model-config.reader` 加按 id 读取），缺省行为不变——「继承父模型」语义自动成立（父子都解析当前启用配置）。
- **usage meta 顺路修**：现状 `modelMeta` 是 ModelResolver 共享实例字段，并行 run 用不同模型时 `llm_calls` 会标错型号（ALS 覆盖会放大此风险）。改法：`resolveModel` 的解析结果（含 meta）随调用返回/存入 run 级上下文，`runGraphStream` 的 usage 事件从**本轮解析结果**取 meta，不再读共享字段。
- 层级纪律：`ModelOverrideContext`、`ModelResolver` 改动都在 libs/agent（无 TypeORM/HTTP）；按 id 读配置沿用现有 `model-config.reader`（直读 SQLite 的既有纯读模块）。

## 7. 前端（增量小）

- **停止按钮**：`SubagentCard` 在卡状态 running 时显示停止 icon → `sub.interrupt()`（`useSessionStream` 已暴露；gateway `session.interrupt` 按会话粒度现成）。i18n 补「停止」键。
- **后台卡状态**：`resolveSubagentStatus` 认识结果 JSON 的 `"running"`（后台 dispatch 立即返回态）——此时状态跟随子流 `sub.running` 与 settled 事件；刷新场景靠已重写的 tool 行直接得终态。
- **消费 `run.subagent_settled`**（对称 1b 的 spawned handler）：按 `toolCallId` 更新 `ToolCallView.result` 为终态 JSON（复用 `claimSubagentOnTimeline` 的打标 idiom，扩展或新增纯函数）。
- 播报气泡零改动（就是普通 user 消息 + 主 Agent 汇报）。

## 8. 边界与错误

- **停止语义**：前台停（父 signal 或卡停止）→ dispatch 返回 aborted，父续跑；后台停（仅卡停止）→ settle 判 aborted → 播报「已中止」。
- **并发**：多个后台任务各自占槽至完成；槽满时新 dispatch（前台或后台）排队——1a 的排队期 abort 短路逻辑保持。
- **子会话不进侧栏 / 统计**：不变（1a/1b 已保证；统计排除 subagent 仍是已记录技术债，本期不做）。
- **仅一层嵌套**：后台子 Agent 同样用去 dispatch 的子图，防护不变。

## 9. 测试

- **server-agent（jest）**：后台立即返回 running JSON；settle 全链（播报 appendMessage+kick / tool 行重写 / settled 事件 / background 置 0 / 槽释放）；终态判定三分支（done/error/aborted）；父会话已删跳过；播报失败重试；重启扫描两分支（有/无活跃 pending）；model 解析失败返回 error；`model_config_id` 写入。
- **libs/agent（vitest）**：`ModelOverrideContext` 传播；`resolveModel` 覆盖优先/缺省不变；usage meta 随解析返回（并行不同模型不串标）。
- **web-agent（根 jest 纯函数）**：`resolveSubagentStatus` 的 running JSON 分支；settled 打标纯函数。
- **收尾**：全量根 jest + boot（含新迁移）+ 真机冒烟：真派一个后台任务（含 model 覆盖）→ 观察立即返回、播报回灌、卡终态；**真实重启一次** server-agent 验证恢复分支；停止按钮中断验证。

## 10. 明确不做

播报消息特殊渲染（就是普通气泡）、子会话用量并入父统计、多层嵌套、后台任务列表管理页、schedule 式定时派发。
