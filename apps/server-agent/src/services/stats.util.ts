import type { StatsRange } from "@meshbot/types-agent";

/** range → 起始时间（含）。"all" 返回 null（无下界）。 */
export function rangeToSince(range: StatsRange, now: Date): Date | null {
  if (range === "all") return null;
  const days = range === "7d" ? 7 : 30;
  const since = new Date(now);
  since.setDate(since.getDate() - days);
  return since;
}

/** 本地日期 YYYY-MM-DD。 */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return localDateKey(dt);
}

/**
 * 从活跃日期集合算连续天数。
 * - current：从 today 往前数的连续活跃天数（today 无活动则为 0）
 * - longest：任意位置的最长连续活跃天数
 */
export function computeStreaks(
  activeDates: string[],
  today: string,
): { current: number; longest: number } {
  const set = new Set(activeDates);
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d;
  }
  let current = 0;
  let cursor = today;
  while (set.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return { current, longest };
}

/** 取消息最多的小时（0–23）；全 0 返回 null。 */
export function pickPeakHour(byHour: number[]): number | null {
  let best = -1;
  let bestCount = 0;
  for (let h = 0; h < byHour.length; h++) {
    if (byHour[h] > bestCount) {
      bestCount = byHour[h];
      best = h;
    }
  }
  return best < 0 ? null : best;
}
