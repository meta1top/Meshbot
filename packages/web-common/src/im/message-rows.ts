/** 每条消息行的渲染元信息(分组 + 日期分隔)。 */
export interface MessageRowMeta {
  showDayDivider: boolean;
  showHeader: boolean;
}

/** 本地日历日 key(年-月-日)。 */
function dayKey(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 标注分组 + 日期分隔;groupKey 决定"换发送者"的判据(行式 senderId、气泡 senderType)。 */
export function annotateRows<T extends { createdAt: string }>(
  messages: T[],
  groupKey: (m: T) => string,
): MessageRowMeta[] {
  let prevDay = "";
  let prevKey = "";
  return messages.map((m) => {
    const dk = dayKey(m.createdAt);
    const showDayDivider = dk !== prevDay;
    const k = groupKey(m);
    const showHeader = showDayDivider || k !== prevKey;
    prevDay = dk;
    prevKey = k;
    return { showDayDivider, showHeader };
  });
}

/** ISO → HH:MM(24h,显式 locale + hour12,避免环境 locale 漂移)。 */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 日期分隔标签:今天 / 昨天 / 本地日期(不依赖环境 locale)。 */
export function dayLabel(
  iso: string,
  today: string,
  yesterday: string,
): string {
  const d = new Date(iso);
  const now = new Date();
  if (isSameDay(d, now)) return today;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (isSameDay(d, y)) return yesterday;
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
