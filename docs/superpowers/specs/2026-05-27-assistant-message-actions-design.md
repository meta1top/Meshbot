# assistant 消息 action row（复制 / 用量 / 点赞 / 不喜欢）— 设计稿

> 日期：2026-05-27
> 范围：web-agent 会话视图 assistant 气泡下方新增操作行；server-agent 新增消息反馈持久化。

## 现状

- assistant 气泡由 [message-list.tsx](../../apps/web-agent/src/components/session/message-list.tsx) 渲染；气泡下方目前是**一行纯文字用量**（`renderUsageLine`：model · input · output · cache · reasoning），无任何操作按钮。
- 用户消息有 `UserMessageActions`（复制 + 重新生成，hover-reveal，`group-hover` 显隐，`navigator.clipboard.writeText` + 成功 2s 显示 `Check`）。assistant 无等价物。
- 每条 assistant 消息的用量数据已通过 history 的 `byMessage: Record<string, MessageUsage>` 提供（`MessageUsage`: providerType / model / inputTokens / outputTokens / totalTokens / cacheReadTokens / cacheCreationTokens / reasoningTokens / durationMs）。
- `@meshbot/design` 有 `Tooltip / TooltipContent / TooltipTrigger`（无 `Popover`）。lucide-react 有 `Copy / Check / Info / ThumbsUp / ThumbsDown`。
- 无任何反馈/评分存储；`SessionMessage.metadata`（JSON 文本列）目前仅用于 compaction 占位行（`{ kind: "compaction", ... }`，是独立行，与 assistant 内容行不同）；assistant 内容行 metadata 恒为 null。
- 无消息级更新端点；消息标识三方对齐：`SessionMessage.id === checkpointer id === socket event messageId`。

## 前端

新组件 `apps/web-agent/src/components/session/assistant-message-actions.tsx`，在 assistant 气泡下方渲染一行操作，**hover 才显示**（外层消息容器 `group` + 本行 `opacity-0 group-hover:opacity-100`，与 `UserMessageActions` 一致）。仅对**非流式、有 content** 的 assistant 消息渲染（流式中/空决策轮不渲染）。

Props：`{ content: string; sessionId: string; messageId: string; usage?: MessageUsage; feedback?: "up" | "down" | null }`。

按钮：
1. **复制**：`navigator.clipboard.writeText(content)` → 成功 2s 显示 `Check`，失败静默（console.error）。复制 markdown 原文。
2. **用量**（仅当 `usage` 存在）：`Info` 图标 + `Tooltip`，hover 出 breakdown：
   - `Prompt {formatTokens(inputTokens)}` / `Completion {formatTokens(outputTokens)}` / `Total {formatTokens(totalTokens)}`
   - 当 `cacheReadTokens > 0` 追加 `Cache {…}`；`reasoningTokens > 0` 追加 `Reasoning {…}`
   - 标签走 i18n。
   - **取代**原 `renderUsageLine` 纯文字行（从 message-list 移除该行）。
3. **点赞 / 不喜欢**：`ThumbsUp` / `ThumbsDown`，互斥 toggle，选中态高亮（`text-accent-foreground` 或 accent 描边）；再点同一个 → 取消（feedback=null）。本地 state 以 `feedback` prop 初始化；点击乐观切换 + 调接口；失败回滚到上一态。

文案：新增 i18n key 命名空间 `session.actions.*`（copy / copied / usage / promptTokens / completionTokens / totalTokens / cacheTokens / reasoningTokens / like / dislike），zh/en 对称。

前端 rest：`apps/web-agent/src/rest/session.ts` 加 `setMessageFeedback(sessionId, messageId, feedback)`。

message-list.tsx：
- 移除 assistant 的纯文字用量行（`renderUsageLine` 调用）。
- 在 assistant 气泡区域挂 `AssistantMessageActions`，传 `usage = usageByMessage?.[m.id]`、`feedback = m.feedback`、`content = m.content`、`sessionId`、`messageId = m.id`。
- 外层 assistant 消息容器加 `group`（若尚无）以驱动 hover-reveal。

## 后端

### 存储
`SessionMessage.metadata` 存 `{ feedback: "up" | "down" }`（assistant 内容行 metadata 原为 null，无冲突）。feedback=null 时清空该字段（metadata 设回 null）。

### Service
`SessionMessageService.setFeedback(messageId: string, feedback: "up" | "down" | null): Promise<void>`：
- 查行（不存在抛 NotFound）；
- `metadata = feedback ? JSON.stringify({ feedback }) : null`；单表 update（无需 `@Transactional`）。

### 端点
`POST /api/sessions/:id/messages/:messageId/feedback`，body `{ feedback: "up" | "down" | null }`（仿 regenerate 端点风格，POST）。
- 新 zod schema `MessageFeedbackSchema = z.object({ feedback: z.enum(["up","down"]).nullable() })` 于 `libs/types-agent`，`createZodDto` 包装为 DTO。
- Controller 校验 messageId 属于该 session（`findByIdOrFail` + sessionId 校验，复用现有模式），调 `setFeedback`，返回 `{ feedback }`。

### history 响应
`HistoryMessageSchema` 加 `feedback: z.enum(["up","down"]).nullable().optional()`（类型 `HistoryMessage.feedback`）。history controller 对 assistant 行解析 metadata：若含 `feedback` 字段则填入 `message.feedback`（与 compaction 占位行的 metadata 解析互不影响——compaction 是独立行）。

## 数据流
进会话 → history 返回每条 assistant 的 `usage`(byMessage) + `feedback` → action row 初始态。点赞/踩 → 组件乐观切换 + `POST .../feedback` → 成功保持，失败回滚 + console.error。复制/用量为纯前端。

## 验收
- assistant 气泡 hover 出现操作行：复制、用量(有 usage 时)、点赞、不喜欢；非流式且有正文才显示。
- 复制 → 剪贴板得到该条 markdown 原文，按钮 2s 显示 Check。
- 用量图标 hover → tooltip 显示 Prompt/Completion/Total（+ 缓存/推理 token 若 >0）；原纯文字用量行消失。
- 点赞/不喜欢互斥 toggle，再点取消；刷新会话后状态保留（已落 metadata）。
- `pnpm check`（6 围栏，重点 check:repo：新端点经归属 Service，不注入 Repo）+ `pnpm typecheck` + `sync:locales --check` 全过。

## 不在范围
- “不喜欢”填写原因/补充输入框。
- 复制富文本 / HTML（仅 markdown 原文）。
- 反馈的导出 / 分析面板（仅存储，留待后续）。
