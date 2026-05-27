/** 0–23 小时 → "6 PM"；null → "—"。 */
export function formatPeakHour(hour: number | null): string {
  if (hour === null) return "—";
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${period}`;
}

/** 连续天数 → "3d"。 */
export function formatStreak(days: number): string {
  return `${days}d`;
}
