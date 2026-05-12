"use client";

import { cn } from "@meshbot/design";

interface ActivityHeatmapProps {
  data: number[];
  maxValue: number;
  className?: string;
}

function getIntensityClass(value: number, maxValue: number): string {
  if (value <= 0) return "bg-background";
  const ratio = value / maxValue;
  if (ratio <= 0.3) return "bg-accent/20";
  if (ratio <= 0.7) return "bg-accent/50";
  return "bg-accent";
}

export function ActivityHeatmap({
  data,
  maxValue,
  className,
}: ActivityHeatmapProps) {
  return (
    <div className={cn("grid grid-cols-16 gap-1", className)}>
      {data.map((value, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: heatmap cells are static ordered
          key={index}
          className={cn(
            "h-5 rounded-[3px]",
            getIntensityClass(value, maxValue),
          )}
        />
      ))}
    </div>
  );
}
