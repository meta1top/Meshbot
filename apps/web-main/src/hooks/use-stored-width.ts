"use client";

import { useCallback, useState } from "react";

/**
 * localStorage 持久化的面板宽度（px）。web-main 没有 jotai（web-agent 那边用
 * atomWithStorage），这里给 `ResizableSheet` 的 `width`/`onWidthChange` 提供等价能力。
 *
 * null = 尚未手动调过 → 由 sheet 用它的 defaultWidth 兜底。惰性初始化里读
 * localStorage：SSR 无 window，首屏渲染直接给 null（与「没调过」同义，不会闪）。
 */
export function useStoredWidth(
  key: string,
): [number | null, (next: number) => void] {
  const [width, setWidth] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(key);
    const n = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  });

  const update = useCallback(
    (next: number) => {
      setWidth(next);
      window.localStorage.setItem(key, String(next));
    },
    [key],
  );

  return [width, update];
}
