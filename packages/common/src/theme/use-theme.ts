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

function applyTheme(theme: Theme) {
  const prefersDark = window.matchMedia(
    "(prefers-color-scheme: dark)",
  ).matches;
  const isDark = theme === "dark" || (theme === "system" && prefersDark);
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
