"use client";

import type {
  MessageUsage,
  RunUsageEvent,
  SessionTotals,
  SessionUsage,
} from "@meshbot/types-agent";
import { atom } from "jotai";

const EMPTY_TOTALS: SessionTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  callCount: 0,
};

/** messageId → 单次 LLM 调用用量。 */
export const usageByMessageAtom = atom<Record<string, MessageUsage>>({});

/** 会话累计 —— 所有 LLM 调用的 SUM + callCount。 */
export const sessionTotalsAtom = atom<SessionTotals>(EMPTY_TOTALS);

/** 用 history 接口返回的 usage 初始化 atoms。 */
export const setInitialUsageAtom = atom(null, (_get, set, u: SessionUsage) => {
  set(usageByMessageAtom, u.byMessage);
  set(sessionTotalsAtom, u.sessionTotals);
});

/** socket run.usage 增量 —— 单条 + 累加。 */
export const appendUsageAtom = atom(null, (get, set, u: RunUsageEvent) => {
  const single: MessageUsage = {
    providerType: u.providerType,
    model: u.model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    reasoningTokens: u.reasoningTokens,
    durationMs: u.durationMs,
  };
  const byMessage = { ...get(usageByMessageAtom), [u.messageId]: single };
  set(usageByMessageAtom, byMessage);
  const t = get(sessionTotalsAtom);
  set(sessionTotalsAtom, {
    inputTokens: t.inputTokens + u.inputTokens,
    outputTokens: t.outputTokens + u.outputTokens,
    totalTokens: t.totalTokens + u.totalTokens,
    cacheReadTokens: t.cacheReadTokens + u.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens + u.cacheCreationTokens,
    reasoningTokens: t.reasoningTokens + u.reasoningTokens,
    callCount: t.callCount + 1,
  });
});

/** 切换会话时重置（避免上轮会话累计串台）。 */
export const resetUsageAtom = atom(null, (_get, set) => {
  set(usageByMessageAtom, {});
  set(sessionTotalsAtom, EMPTY_TOTALS);
});
