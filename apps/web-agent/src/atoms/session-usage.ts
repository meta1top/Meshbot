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
  lastInputTokens: 0,
};

/**
 * 从 byMessage 重算 sessionTotals。
 *
 * byMessage 是 Record 无顺序，没法从里面算「最后一次」；调用方需要把服务端
 * 报告的 lastInputTokens 显式传入（来自 SessionUsage.sessionTotals）。
 */
function computeTotals(
  byMessage: Record<string, MessageUsage>,
  lastInputTokens: number,
): SessionTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let reasoningTokens = 0;
  let callCount = 0;
  for (const m of Object.values(byMessage)) {
    inputTokens += m.inputTokens;
    outputTokens += m.outputTokens;
    totalTokens += m.totalTokens;
    cacheReadTokens += m.cacheReadTokens;
    cacheCreationTokens += m.cacheCreationTokens;
    reasoningTokens += m.reasoningTokens;
    callCount += 1;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    callCount,
    lastInputTokens,
  };
}

/** messageId → 单次 LLM 调用用量。 */
export const usageByMessageAtom = atom<Record<string, MessageUsage>>({});

/** 会话累计 —— 所有 LLM 调用的 SUM + callCount。 */
export const sessionTotalsAtom = atom<SessionTotals>(EMPTY_TOTALS);

/** 用 history 接口返回的 usage 初始化 atoms（merge 而非覆盖，避免竞态丢计）。 */
export const setInitialUsageAtom = atom(null, (get, set, u: SessionUsage) => {
  const existing = get(usageByMessageAtom);
  // 合并历史 + 已通过 appendUsage 累计的（按 messageId 去重，atom 中已存在的优先）
  const merged: Record<string, MessageUsage> = { ...u.byMessage };
  for (const [id, m] of Object.entries(existing)) {
    merged[id] = m;
  }
  set(usageByMessageAtom, merged);
  // sessionTotals 从合并后的 byMessage 求和重算（避免双计或丢计）；
  // lastInputTokens 信任服务端：byMessage 无顺序拿不到，server SessionTotals 是源。
  set(
    sessionTotalsAtom,
    computeTotals(merged, u.sessionTotals.lastInputTokens),
  );
});

/** socket run.usage 增量 —— 单条 + 累加（同 messageId 幂等跳过）。 */
export const appendUsageAtom = atom(null, (get, set, u: RunUsageEvent) => {
  const existing = get(usageByMessageAtom);
  // 同 messageId 已在 → 幂等跳过（避免 socket 重传 / setInitialUsage 双计）
  if (existing[u.messageId]) {
    return;
  }
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
  const byMessage = { ...existing, [u.messageId]: single };
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
    lastInputTokens: u.inputTokens,
  });
});

/** 切换会话时重置（避免上轮会话累计串台）。 */
export const resetUsageAtom = atom(null, (_get, set) => {
  set(usageByMessageAtom, {});
  set(sessionTotalsAtom, EMPTY_TOTALS);
});

/**
 * 合并一批 byMessage 到 usageByMessageAtom。
 * 用于翻页时把老消息的 usage 投影合进展示。同 id 覆盖（不该重复）。
 */
export const appendUsageByMessageAtom = atom(
  null,
  (get, set, batch: Record<string, MessageUsage>) => {
    const current = get(usageByMessageAtom);
    set(usageByMessageAtom, { ...current, ...batch });
  },
);
