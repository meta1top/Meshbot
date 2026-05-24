"use client";

/**
 * 首屏骨架占位 —— 6 条灰底 pulse 方块。只在「会话」分组下用；
 * pinned 分组默认隐藏，不为它渲染骨架。
 */
export function SessionListSkeleton() {
  return (
    <div className="mt-1 space-y-0.5">
      {(["a", "b", "c", "d", "e", "f"] as const).map((id) => (
        <div key={id} className="h-7 w-full animate-pulse bg-foreground/5" />
      ))}
    </div>
  );
}
