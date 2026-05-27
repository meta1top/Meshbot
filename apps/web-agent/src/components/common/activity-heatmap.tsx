"use client";

import { cn } from "@meshbot/design";

interface ActivityHeatmapProps {
  /** 有活动的天（date=YYYY-MM-DD 本地时区，count 当天消息数）；其余天补 0。 */
  cells: { date: string; count: number }[];
  /** 展示窗口周数，默认 18（固定，不随时间筛选变化）。 */
  weeks?: number;
  className?: string;
}

/** 按当天计数相对峰值取强度色（沿用主题 accent）。 */
function intensityClass(value: number, max: number): string {
  if (value <= 0) return "bg-foreground/5";
  const ratio = value / max;
  if (ratio <= 0.25) return "bg-accent/30";
  if (ratio <= 0.6) return "bg-accent/60";
  return "bg-accent";
}

/** 本地日期 YYYY-MM-DD。 */
function localKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * GitHub / Claude Code desktop 风格的活跃度日历网格：
 * 7 行（周日→周六）× N 列（周），固定展示最近 weeks*7 天，列按周从左到右、
 * 列内按星期从上到下（grid-flow-col）。空白天为深色底，有活动的按强度上色。
 */
export function ActivityHeatmap({
  cells,
  weeks = 18,
  className,
}: ActivityHeatmapProps) {
  const counts = new Map(cells.map((c) => [c.date, c.count]));
  const max = Math.max(1, ...cells.map((c) => c.count));

  const totalDays = weeks * 7;
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - (totalDays - 1));

  // 前导空格让首列首格对齐到 start 的星期（周日=0），网格按真实星期排布
  const lead = start.getDay();
  const slots: ({ key: string; count: number } | null)[] = [];
  for (let i = 0; i < lead; i++) slots.push(null);
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = localKey(d);
    slots.push({ key, count: counts.get(key) ?? 0 });
  }
  const cols = Math.ceil(slots.length / 7);

  return (
    <div
      className={cn("grid grid-flow-col gap-1", className)}
      style={{
        gridTemplateRows: "repeat(7, minmax(0, 1fr))",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      }}
    >
      {slots.map((slot, i) =>
        slot === null ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 前导对齐占位，无语义 key
          <span key={`pad-${i}`} className="aspect-square" />
        ) : (
          <span
            key={slot.key}
            className={cn(
              "aspect-square rounded-[3px]",
              intensityClass(slot.count, max),
            )}
          />
        ),
      )}
    </div>
  );
}
