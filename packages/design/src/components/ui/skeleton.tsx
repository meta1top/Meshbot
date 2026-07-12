import { cn } from "../../lib/utils";

/** 骨架屏基础块：形状由调用方 className 决定（h-4 w-32 / h-10 w-10 rounded-full…）。 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-md bg-muted", className)}
    />
  );
}
