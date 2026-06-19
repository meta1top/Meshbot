/** 每条消息行的渲染元信息（分组 + 日期分隔）。 */
export interface MessageRowMeta {
  /** 此行上方是否插日期分隔条（首条 / 跨天）。 */
  showDayDivider: boolean;
  /** 此行是否显示头部（头像 + 名字 + 时间）；分组行为 false。 */
  showHeader: boolean;
}

/** 本地日历日 key（按本地年-月-日，符合 IM 用户直觉的「同一天」）。 */
function dayKey(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 标注消息流的分组与日期分隔：
 * 跨天 → 分隔 + 头行；同天换发送者 → 头行；同天同发送者 → 分组行。
 */
export function annotateRows(
  messages: { senderId: string; createdAt: string }[],
): MessageRowMeta[] {
  let prevDay = "";
  let prevSender = "";
  return messages.map((msg) => {
    const dk = dayKey(msg.createdAt);
    const showDayDivider = dk !== prevDay;
    const showHeader = showDayDivider || msg.senderId !== prevSender;
    prevDay = dk;
    prevSender = msg.senderId;
    return { showDayDivider, showHeader };
  });
}
