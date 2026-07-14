/**
 * dispatch_subagent 嵌套卡纯逻辑：实现与单测已迁入
 * `packages/web-common/src/session/subagent-card.ts`（Task 6，随 `useSessionStream`
 * 一并迁移——该文件本就零依赖纯函数，符合 web-common 的 jotai / next-intl / app
 * 路径禁令）。本文件改为薄 re-export，`@/lib/subagent-card` 既有 import 路径
 * （`subagent-card.tsx` 组件等）不变。
 */
export {
  claimSubagentOnTimeline,
  countToolCalls,
  deriveLiveAction,
  firstLineOf,
  formatElapsed,
  isBackgroundDispatch,
  isSubagentOpen,
  type LiveAction,
  resolveSubagentStatus,
  resolveSubSessionId,
  resolveUnclaimedStatus,
  type SubagentCollapse,
  type SubagentStatus,
  type SubagentStreamSlice,
  type SubagentToolSlice,
  settleSubagentOnTimeline,
  subagentTitle,
  toggleSubagentOpen,
  truncate,
} from "@meshbot/web-common/session";
