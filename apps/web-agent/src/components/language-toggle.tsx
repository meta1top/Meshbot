"use client";

import { useAppLocale } from "@/components/intl-provider";

export function LanguageToggle() {
  const { locale, setLocale } = useAppLocale();
  const nextLocale = locale === "zh" ? "en" : "zh";

  return (
    <button
      type="button"
      className="flex h-7 min-w-[40px] items-center justify-center border border-border px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      onClick={() => setLocale(nextLocale)}
    >
      {nextLocale.toUpperCase()}
    </button>
  );
}
