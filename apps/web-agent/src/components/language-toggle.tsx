"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { localeCookieName } from "@/i18n/config";

export function LanguageToggle() {
  const locale = useLocale();
  const router = useRouter();
  const nextLocale = locale === "zh" ? "en" : "zh";

  return (
    <button
      type="button"
      className="flex h-7 min-w-[40px] items-center justify-center border border-border px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      onClick={() => {
        // biome-ignore lint: Persist locale preference for next-intl request config.
        document.cookie = `${localeCookieName}=${nextLocale}; path=/; max-age=31536000; SameSite=Lax`;
        router.refresh();
      }}
    >
      {nextLocale.toUpperCase()}
    </button>
  );
}
