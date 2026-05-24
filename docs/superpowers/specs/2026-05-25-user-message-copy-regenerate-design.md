# 用户消息复制 + 重生成（重试）设计

## 目标

每条 user 消息气泡下方加两个 hover-显的按钮：
- **复制** —— 直接复制文本内容
- **重生成 / 重试** —— 删除该消息之后的所有内容（含 assistant / tool / 后续轮），从该 user 消息重新走 LLM。失败状态下按钮语义变成「重试」（底层一致）。

failed 状态下 user 气泡背景色变浅错误色，重试按钮默认显示（不需要 hover 引导）。

## 范围

**做：**
- 后端：新 `POST /api/sessions/:sessionId/messages/:messageId/regenerate` 端点
- session_messages / llm_calls 两个 service 各加 `deleteAfter(sessionId, createdAt)`
- SessionService 编排 + 用 LangGraph RemoveMessage 剪 checkpointer state
- RunnerService 加 `kickResume(sessionId)`（不依赖 pending 表的 resume 触发）
- 前端：新 `UserMessageActions` 组件 + message-list 接入
- failed 状态 user 气泡背景色 + 裁掉原「失败 [重试]」inline 文字
- 重试请求飞行期间按钮 spinner + disabled

**不做：**
- assistant 消息上的按钮（本期仅 user）
- 编辑 user 消息后再重生成（仅原文重跑）
- 失败回滚乐观截断（失败 toast + 提示刷新）
- 重试中断当前 inflight run（inflight 期间按钮 disabled，让 run 完）

## 后端

### 路由

`POST /api/sessions/:sessionId/messages/:messageId/regenerate`

请求体：空。  
返回：`{ regenerated: true }`

### 行为

`SessionController.regenerate(sessionId, messageId)`：

1. 调 `SessionService.regenerateAfter(sessionId, messageId)`
2. 调 `RunnerService.kickResume(sessionId)`
3. 返 `{ regenerated: true }`

### `SessionService.regenerateAfter(sessionId, messageId)`

```ts
async regenerateAfter(sessionId: string, messageId: string): Promise<void> {
  await this.findSessionOrFail(sessionId);
  const msg = await this.sessionMessages.findByIdOrFail(messageId);
  if (msg.sessionId !== sessionId) throw new NotFoundException(...);
  if (msg.role !== "user") {
    throw new BadRequestException("仅 user 消息支持重生成");
  }
  // 1. 删 session_messages / llm_calls 中 createdAt > cutoff 的所有行
  await this.sessionMessages.deleteAfter(sessionId, msg.createdAt);
  await this.llmCalls.deleteAfter(sessionId, msg.createdAt);
  // 2. 剪 checkpointer state：按 messageId 集合剪
  //    遍历 graph state messages，找到 cutoff message 的 index，删后面所有有 id 的
  await this.regenerateCutCheckpointer(sessionId, messageId);
}

/**
 * 找到 checkpointer state.messages 里 messageId 之后的所有消息，用
 * RemoveMessage 批量剪（messages reducer 已支持 RemoveMessage）。
 * 注意：cutoff 消息本身（id === messageId）保留。
 */
private async regenerateCutCheckpointer(
  sessionId: string,
  messageId: string,
): Promise<void> {
  // 通过 GraphService 暴露的方法做（避免 SessionService 直接依赖 LangGraph）
  await this.graph.cutMessagesAfter(sessionId, messageId);
}
```

注意 `SessionService` 要 inject `GraphService`（已经 inject 过吗？检查），并加 SessionMessageService、LlmCallService（commit da26e21 deleteSession 已经 inject 过这俩，无新增依赖）。GraphService 不在 SessionModule，但 AgentModule 已 export，SessionModule import AgentModule，可以 inject。

如果 GraphService inject 进 SessionService 引入循环（GraphService → SessionService??），改在 controller 层调 graph 方法 —— controller 已 inject runner，加 graph 不复杂。

### `GraphService.cutMessagesAfter(threadId, cutoffMessageId)`

```ts
/**
 * 从 checkpointer state 里剪掉 cutoff message 之后的所有消息（含 assistant
 * / tool / 后续轮 user）。cutoff 本身保留。供「重生成」流程用。
 *
 * 用 RemoveMessage + updateState（messages reducer 已支持 RemoveMessage）。
 */
async cutMessagesAfter(threadId: ThreadId, cutoffMessageId: string): Promise<void> {
  const snapshot = await this.graph.getState({
    configurable: { thread_id: threadId },
  });
  const msgs = (snapshot.values as GraphState | undefined)?.messages ?? [];
  const idx = msgs.findIndex((m) => m.id === cutoffMessageId);
  if (idx < 0) return; // 找不到就不剪，让后续流程自己决定
  const toRemove = msgs
    .slice(idx + 1)
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");
  if (toRemove.length === 0) return;
  await this.graph.updateState(
    { configurable: { thread_id: threadId } },
    { messages: toRemove.map((id) => new RemoveMessage({ id })) },
  );
}
```

### `SessionMessageService.deleteAfter(sessionId, createdAt)`

```ts
/**
 * 删某会话内 createdAt > cutoff 的所有消息。供「重生成」剪 history 用。
 * cutoff 本身保留（严格 >，不是 >=）。
 */
async deleteAfter(sessionId: string, cutoff: Date): Promise<void> {
  await this.repo.delete({
    sessionId,
    createdAt: MoreThan(cutoff),
  });
}
```

需要 import `MoreThan` from typeorm。

### `LlmCallService.deleteAfter(sessionId, createdAt)`

```ts
/**
 * 删某会话内 createdAt > cutoff 的所有 LLM 调用记录。供「重生成」剪 usage 用。
 */
async deleteAfter(sessionId: string, cutoff: Date): Promise<void> {
  await this.llmCallRepo.delete({
    sessionId,
    createdAt: MoreThan(cutoff),
  });
}
```

### `SessionMessageService.findByIdOrFail(messageId)`

```ts
async findByIdOrFail(messageId: string): Promise<SessionMessage> {
  const row = await this.repo.findOneBy({ id: messageId });
  if (!row) throw new NotFoundException(`SessionMessage ${messageId} not found`);
  return row;
}
```

### `RunnerService.kickResume(sessionId)`

```ts
/**
 * 触发 resume：不 claim pending_messages，直接走 resumeStream（checkpointer
 * 现有 state 重新跑一轮）。供「重生成」用。
 * running 哨兵防双 kick。
 */
kickResume(sessionId: string): void {
  if (this.running.has(sessionId)) return;
  void this.kickResumeAndWait(sessionId).catch((err) => {
    this.logger.error(`resume loop crashed for ${sessionId}`, err);
  });
}

async kickResumeAndWait(sessionId: string): Promise<void> {
  if (this.running.has(sessionId)) return;
  this.running.add(sessionId);
  await this.sessions.setStatus(sessionId, "running");
  try {
    await this.runOnce(sessionId, [], true); // batch 空 + resume=true
  } catch (err) {
    this.logger.warn(`resume runOnce 失败：${sessionId}`, err);
  } finally {
    this.running.delete(sessionId);
    await this.sessions.setStatus(sessionId, "idle");
  }
}
```

注意 `runOnce(sessionId, [], true)` 当前签名 batch 是非空假设；要么改签名允许空 batch，要么 resume 路径单独走（不调 runOnce）。看 runOnce 实现：batch 用于「emit run.human / markProcessed」—— 空 batch 时这两步 no-op 即可，应该不破。但为稳妥，**新加一个 `runOnceResume(sessionId)` 私有方法**专跑 resume，避免改 runOnce 签名。

更简单的实现：直接复用 `runOnce` 让它接受 `batch: []`：现有 `for (const event of stream)` 里 `event.kind === "human"` 只在 batch 有内容时触发；`markProcessed(ids)` 当 ids 空数组时也是 no-op。**改 runOnce 内部 `if (ids.length > 0) markProcessed`** 即可。

实施时验证：当前 markProcessed 已经 `if (ids.length === 0) return`（task 4 / commit b1207cd？），如已就绪不用改。

## 前端

### REST client

`apps/web-agent/src/rest/session.ts` 加：

```ts
/** 从某条 user 消息重新生成（删后面 + 重跑）。 */
export async function regenerateMessage(
  sessionId: string,
  messageId: string,
): Promise<{ regenerated: true }> {
  const { data } = await apiClient.post<{ regenerated: true }>(
    `/api/sessions/${sessionId}/messages/${messageId}/regenerate`,
    {},
  );
  return data;
}
```

### UserMessageActions 组件

`apps/web-agent/src/components/session/user-message-actions.tsx`：

```tsx
"use client";

import { cn } from "@meshbot/design";
import { Check, Copy, Loader2, RotateCcw } from "lucide-react";
import { useState, useCallback } from "react";

interface Props {
  sessionId: string;
  messageId: string;
  content: string;
  /** 失败状态：按钮默认可见（不需要 hover），label 「重试」。 */
  failed?: boolean;
  /** 会话有 inflight run：重试按钮 disabled。 */
  running?: boolean;
  /** 父组件清空当前及之后 timeline（乐观），实现「即时反馈」。 */
  onOptimisticCut: () => void;
  /** 失败时父组件可弹 toast。 */
  onError?: (err: unknown) => void;
}

export function UserMessageActions({
  sessionId,
  messageId,
  content,
  failed,
  running,
  onOptimisticCut,
  onError,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      onError?.(err);
    }
  }, [content, onError]);

  const handleRegenerate = useCallback(async () => {
    if (busy || running) return;
    setBusy(true);
    onOptimisticCut();
    try {
      const { regenerateMessage } = await import("@/rest/session");
      await regenerateMessage(sessionId, messageId);
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  }, [busy, running, sessionId, messageId, onOptimisticCut, onError]);

  return (
    <div
      className={cn(
        "mt-1 flex items-center gap-1.5 transition-opacity",
        failed
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100",
      )}
    >
      <button
        type="button"
        onClick={handleCopy}
        title="复制"
        className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={handleRegenerate}
        disabled={busy || running}
        title={failed ? "重试" : "重新生成"}
        className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RotateCcw className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
```

文案不走 i18n（本期单独不引入，跟现有 user 操作短文按钮一致；未来批量做 sidebar i18n 时再加）。

### message-list.tsx 改动

a) `MessageListProps` 加 `sessionId: string; running: boolean; onRegenerateOptimisticCut: (messageId: string) => void;`，删除 `onRetry`。

b) user 气泡 div 改 `group` className（让 hover 触发子组件 opacity-100）：

```tsx
<div
  key={m.id}
  className={cn(
    "group flex max-w-[80%] flex-col gap-2",
    m.role === "user" ? "self-end items-end" : "self-start",
  )}
>
```

c) user 气泡背景：

```tsx
m.role === "user"
  ? cn(
      "px-3.5 py-2 text-foreground whitespace-pre-wrap",
      m.failed ? "bg-destructive/8" : "bg-foreground/8",
    )
  : "text-foreground"
```

d) 裁掉现有「失败 [重试]」inline 段：

```tsx
{m.failed && (
  <span className="ml-2 text-xs text-destructive">
    失败
    <button onClick={onRetry} ...>重试</button>
  </span>
)}
```

整段删除。

e) user 气泡之后挂 `<UserMessageActions />`：

```tsx
{m.role === "user" && (
  <UserMessageActions
    sessionId={sessionId}
    messageId={m.id}
    content={m.content}
    failed={m.failed}
    running={running}
    onOptimisticCut={() => onRegenerateOptimisticCut(m.id)}
  />
)}
```

### session/page.tsx 改动

- `MessageList` 调用处传 `sessionId={sessionId}`、`running={running}`、`onRegenerateOptimisticCut={(id) => apply(prev => prev.slice(0, prev.findIndex(m => m.id === id) + 1))}`
- 删 `onRetry` prop

`onRetry` 老的 pending-list 走 `retrySession(sessionId)`（针对 failed pending 消息），跟 user 消息重试是两个东西。pending 那个保留。但 messageList 内部传给 user 气泡的 onRetry 删掉 —— 现在走 onRegenerateOptimisticCut。

## 不变量

- 重生成后：session_messages / llm_calls 里 createdAt > cutoff 的行全删；checkpointer 里 cutoff 之后的 message 全剪
- cutoff user 消息本身**永远保留**（DB + checkpointer）
- inflight run 期间重生成按钮 disabled，避免双 run
- failed 状态背景色 destructive/8；正常 foreground/8

## 错误 / 边界

- regenerate 接口 404（messageId 不存在或不属于 session） → 前端 toast「消息不存在」+ 重新拉 history
- regenerate 网络失败 → 乐观截断**不回滚**（按 spec 决定），toast 让用户刷新
- 复制失败（permission denied / 不支持 navigator.clipboard）→ toast「复制失败」
- failed user 消息的 cutoff：session_messages 里有它（recordUser 写入）；删后面没东西可删；checkpointer 里末尾就是它；resume 直接重跑。流程一致。

## 测试

### 单测

- `SessionMessageService.deleteAfter` —— 准备 3 条不同 createdAt 的消息，删 cutoff，留前 N 条
- `LlmCallService.deleteAfter` —— 同款
- `SessionMessageService.findByIdOrFail` —— 不存在抛 NotFound
- `GraphService.cutMessagesAfter` —— in-memory state 准备 5 条消息，剪 cutoff 后只剩前 K 条
- `SessionService.regenerateAfter` —— 集成：建会话 + 模拟历史 → regenerate → 断言三处都剪干净

### 不写
- e2e 不补（已有 retry e2e；本次走单测即可）

## 未来扩展

- assistant 消息上加复制（同款 actions，去掉重试）
- 编辑后重生成（先打开 user 气泡为可编辑 input，保存后才走 regenerate；UX 复杂）
- 重生成时让用户选「保留旧 assistant 作为分支」（多版本对比，非线性）
