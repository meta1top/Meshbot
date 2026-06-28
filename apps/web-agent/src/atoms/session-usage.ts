"use client";

import type {
  MessageUsage,
  RunUsageEvent,
  SessionTotals,
  SessionUsage,
} from "@meshbot/types-agent";
import { atom } from "jotai";
import { atomFamily } from "jotai/utils";

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

/**
 * messageId → 单次 LLM 调用用量，**按 sessionId 隔离**。
 * 主会话与 dock 是两个并发会话，各自 useSessionStream 都写 usage；用 atomFamily
 * 让每会话各持一份，避免用量互相覆盖/累加（串台）。
 */
export const usageByMessageFamily = atomFamily((_sessionId: string) =>
  atom<Record<string, MessageUsage>>({}),
);

/** 会话累计 —— 所有 LLM 调用的 SUM + callCount（按 sessionId 隔离）。 */
export const sessionTotalsFamily = atomFamily((_sessionId: string) =>
  atom<SessionTotals>(EMPTY_TOTALS),
);

/** 用 history 接口返回的 usage 初始化某会话的 atoms（merge 而非覆盖，避免竞态丢计）。 */
export const setInitialUsageAtom = atom(
  null,
  (
    get,
    set,
    { sessionId, usage }: { sessionId: string; usage: SessionUsage },
  ) => {
    const byMsg = usageByMessageFamily(sessionId);
    const existing = get(byMsg);
    // 合并历史 + 已通过 appendUsage 累计的（按 messageId 去重，atom 中已存在的优先）
    const merged: Record<string, MessageUsage> = { ...usage.byMessage };
    for (const [id, m] of Object.entries(existing)) {
      merged[id] = m;
    }
    set(byMsg, merged);
    // sessionTotals 从合并后的 byMessage 求和重算（避免双计或丢计）；
    // lastInputTokens 信任服务端：byMessage 无顺序拿不到，server SessionTotals 是源。
    set(
      sessionTotalsFamily(sessionId),
      computeTotals(merged, usage.sessionTotals.lastInputTokens),
    );
  },
);

/** socket run.usage 增量 —— 单条 + 累加（同 messageId 幂等跳过）。 */
export const appendUsageAtom = atom(
  null,
  (
    get,
    set,
    { sessionId, event }: { sessionId: string; event: RunUsageEvent },
  ) => {
    const byMsg = usageByMessageFamily(sessionId);
    const existing = get(byMsg);
    // 同 messageId 已在 → 幂等跳过（避免 socket 重传 / setInitialUsage 双计）
    if (existing[event.messageId]) {
      return;
    }
    const single: MessageUsage = {
      providerType: event.providerType,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      totalTokens: event.totalTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      reasoningTokens: event.reasoningTokens,
      durationMs: event.durationMs,
    };
    set(byMsg, { ...existing, [event.messageId]: single });
    const totals = sessionTotalsFamily(sessionId);
    const t = get(totals);
    set(totals, {
      inputTokens: t.inputTokens + event.inputTokens,
      outputTokens: t.outputTokens + event.outputTokens,
      totalTokens: t.totalTokens + event.totalTokens,
      cacheReadTokens: t.cacheReadTokens + event.cacheReadTokens,
      cacheCreationTokens: t.cacheCreationTokens + event.cacheCreationTokens,
      reasoningTokens: t.reasoningTokens + event.reasoningTokens,
      callCount: t.callCount + 1,
      lastInputTokens: event.inputTokens,
    });
  },
);

/** 重置某会话的 usage 累计（进入会话时从 history 重建前先清）。 */
export const resetUsageAtom = atom(null, (_get, set, sessionId: string) => {
  set(usageByMessageFamily(sessionId), {});
  set(sessionTotalsFamily(sessionId), EMPTY_TOTALS);
});

/**
 * 合并一批 byMessage 到某会话的 usageByMessage。
 * 用于翻页时把老消息的 usage 投影合进展示。同 id 覆盖（不该重复）。
 */
export const appendUsageByMessageAtom = atom(
  null,
  (
    get,
    set,
    {
      sessionId,
      batch,
    }: { sessionId: string; batch: Record<string, MessageUsage> },
  ) => {
    const byMsg = usageByMessageFamily(sessionId);
    set(byMsg, { ...get(byMsg), ...batch });
  },
);
