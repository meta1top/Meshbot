/**
 * 判定推理块是否仍在「思考中」（计时器要不要继续涨）。
 *
 * 判据顺序是要害：`durationMs` 一旦被锁定（onReasoningDone / 打断收尾
 * settleInterruptedTimeline 写入）就是终态权威，无视 `streaming`。
 * 消息级 `streaming` 要到 `run.tool_call_start`（工具真正开始执行）才转 false，
 * 而「推理结束 → 工具开始执行」之间还夹着 tool args 流式（长 args 的 write_file
 * 可长达几十秒）；把 streaming 排在前面会让这段时间继续按 now-startedAt 计时，
 * 表现为「推理已结束、工具已在跑，思考中 Xs 还在涨」。
 *
 * streaming 降级为 durationMs 缺失时的兜底信号：刷新落在 reasoning 流式中时，
 * 只有 reasoning + reasoningStartedAt、没有 durationMs，仍需判为思考中。
 */
export function isReasoningThinking(params: {
  startedAt?: number;
  durationMs?: number;
  streaming?: boolean;
}): boolean {
  const { startedAt, durationMs, streaming } = params;
  if (durationMs !== undefined) return false;
  return streaming === true || startedAt !== undefined;
}
