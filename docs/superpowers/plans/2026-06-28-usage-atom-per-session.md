# usage atom 按 session 隔离 + dock 显示 token

> 简短 plan（方案已与用户敲定，连贯实施）。

**Goal:** 把全局单例 usage atom 改为按 `sessionId` 隔离，根治主会话/dock 并发会话的 token 串台；并给 dock 接线显示 token（输入框环 + AI 回复图标）。

**根因:** `usageByMessageAtom`/`sessionTotalsAtom` 是全局单例，主会话与 dock 两个 `useSessionStream` 都往里写（`resetUsage`/`appendUsage` 累加式）→ 用量互相覆盖/累加。

## 改动

### 1. `apps/web-agent/src/atoms/session-usage.ts`（核心）
- `usageByMessageAtom` → `usageByMessageFamily = atomFamily((sid: string) => atom<Record<string, MessageUsage>>({}))`。
- `sessionTotalsAtom` → `sessionTotalsFamily = atomFamily((sid: string) => atom<SessionTotals>(EMPTY_TOTALS))`。
- 4 个 setter atom 改为接收带 `sessionId` 的 payload，内部操作 `family(sessionId)`：
  - `setInitialUsageAtom`: `{ sessionId, usage: SessionUsage }`。
  - `appendUsageAtom`: `{ sessionId, event: RunUsageEvent }`。
  - `appendUsageByMessageAtom`: `{ sessionId, batch: Record<string, MessageUsage> }`。
  - `resetUsageAtom`: `sessionId: string`。
- `computeTotals` 不变。`import { atomFamily } from "jotai/utils"`。

### 2. `apps/web-agent/src/hooks/use-session-stream.ts`
- 4 处调用传 `sessionId`：
  - L170 `resetUsage()` → `resetUsage(sessionId)`。
  - L281 `setInitialUsage({ sessionTotals, byMessage })` → `setInitialUsage({ sessionId, usage: { sessionTotals: history.sessionTotals, byMessage: history.byMessage } })`（按现有 payload 形态包裹）。
  - L287 `appendUsageByMessage(history.byMessage)` → `appendUsageByMessage({ sessionId, batch: history.byMessage })`。
  - L483 `appendUsage(e)` → `appendUsage({ sessionId, event: e })`。
  - L758 `appendUsageByMessage(res.byMessage)` → `appendUsageByMessage({ sessionId, batch: res.byMessage })`。

### 3. `apps/web-agent/src/components/session/assistant-conversation-body.tsx`
- `useAtomValue(usageByMessageAtom)` → `useAtomValue(usageByMessageFamily(id))`；`sessionTotalsAtom` → `sessionTotalsFamily(id)`。

### 4. `apps/web-agent/src/components/im/assistant-dock.tsx`（接线显示）
- 读本 session 的 usage：`useAtomValue(usageByMessageFamily(sessionId ?? ""))` + `sessionTotalsFamily(sessionId ?? "")`。
- `useModelConfigs` → `enabledModel` → `contextWindow ?? 128_000`（同主会话）。
- `MessageList` 传 `usageByMessage={usageByMessage}`。
- `ChatInput` 传 `tokenUsage={{ current: sessionTotals.lastInputTokens, max: contextWindow, breakdown: {...} }}`（照搬主会话结构）。
- 注意 `sessionId` 可能为 null（首条惰性创建前）；用 `sessionId ?? ""` 兜底，family("") 返回空 usage，token 环显示 0/上限，无碍。

## 验证
- `pnpm turbo typecheck --filter=@meshbot/web-agent` 绿。
- `npx biome check --write` 改动文件。
- **手动**：主会话 + dock 同时打开各自发消息，两边 token 环/回复图标各自独立、不串、不相互累加。
