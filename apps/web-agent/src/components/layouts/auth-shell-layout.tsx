"use client";

import { cn } from "@meshbot/design";
import { useTheme } from "@meshbot/web-common/react";
import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { DragRegion } from "@/components/drag-region";
import { LanguageToggle } from "@/components/language-toggle";

interface AuthShellLayoutProps {
  children: React.ReactNode;
  className?: string;
}

export function AuthShellLayout({ children, className }: AuthShellLayoutProps) {
  const [mounted, setMounted] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const tCommon = useTranslations("common");
  const t = useTranslations("login");

  useEffect(() => {
    document.body.classList.add("auth-shell-mode");
    setMounted(true);
    return () => {
      document.body.classList.remove("auth-shell-mode");
    };
  }, []);

  return (
    <div className="relative flex min-h-screen overflow-hidden bg-background text-foreground">
      <DragRegion
        actions={
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <button
              type="button"
              onClick={toggleTheme}
              className="flex h-7 w-7 items-center justify-center border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              title={
                theme === "dark"
                  ? tCommon("switchToLightTheme")
                  : tCommon("switchToDarkTheme")
              }
            >
              {theme === "dark" ? (
                <Sun className="h-3.5 w-3.5" />
              ) : (
                <Moon className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        }
      />
      {/* 左品牌色块 */}
      <div className="relative hidden w-[44%] flex-col justify-between overflow-hidden bg-linear-to-br from-(--shell-chrome) to-(--shell-accent) p-10 text-white lg:flex">
        <BrandLogo size="md" withWordmark className="auth-brand" />
        <div>
          <div className="text-[28px] font-extrabold leading-snug">
            {t("brandTagline")}
          </div>
          <div className="mt-3 text-sm text-white/85">{t("brandSubtitle")}</div>
        </div>
        <div className="pointer-events-none absolute -right-12 -bottom-12 h-48 w-48 rounded-full border-[20px] border-white/10" />
      </div>
      {/* 右内容 */}
      <div
        className={cn(
          "relative z-10 flex min-h-0 flex-1 items-center justify-center px-6",
          className,
        )}
      >
        {mounted ? children : null}
      </div>
    </div>
  );
}
