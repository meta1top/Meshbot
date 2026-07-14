import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Theme } from "./constants";
import { THEME_STORAGE_KEY } from "./constants";

const listeners = new Set<() => void>();

function getSnapshot(): Theme {
  if (typeof window === "undefined") return "system";
  return (localStorage.getItem(THEME_STORAGE_KEY) as Theme) || "system";
}

function getServerSnapshot(): Theme {
  return "system";
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * 掐掉主题切换那一帧的过渡：CSS 变量是瞬间整体换掉的，但为 hover 挂了
 * transition-colors 的元素（侧栏会话项、产物文件卡等）会把这次变量变化也当成
 * 补间动画——满屏瞬变、唯独几块在慢慢渐变，观感很怪。样式见 design 包 globals.css
 * 的 `html.theme-switching`。用双 rAF 撤销：第一帧让新变量与 none 一起提交，
 * 第二帧再放开过渡，此时颜色已是终值，不会补间。
 */
function suppressTransitionsForOneFrame(): void {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
  });
}

function applyTheme(theme: Theme) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = theme === "dark" || (theme === "system" && prefersDark);
  if (isDark === document.documentElement.classList.contains("dark")) return;
  suppressTransitionsForOneFrame();
  document.documentElement.classList.toggle("dark", isDark);
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (getSnapshot() === "system") applyTheme("system");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
    for (const cb of listeners) cb();
  }, []);

  const toggleTheme = useCallback(() => {
    const current = getSnapshot();
    const next = current === "dark" ? "light" : "dark";
    setTheme(next);
  }, [setTheme]);

  return { theme, setTheme, toggleTheme } as const;
}
