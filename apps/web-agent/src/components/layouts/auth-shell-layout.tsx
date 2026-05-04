"use client";

import { useTheme } from "@anybot/common";
import { cn } from "@anybot/design";
import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { DragRegion } from "@/components/drag-region";
import { LanguageToggle } from "@/components/language-toggle";

interface AuthShellLayoutProps {
  children: React.ReactNode;
  className?: string;
}

export function AuthShellLayout({ children, className }: AuthShellLayoutProps) {
  const [mounted, setMounted] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const t = useTranslations("common");

  useEffect(() => {
    document.body.classList.add("auth-shell-mode");
    setMounted(true);
    return () => {
      document.body.classList.remove("auth-shell-mode");
    };
  }, []);

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background text-foreground">
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
                  ? t("switchToLightTheme")
                  : t("switchToDarkTheme")
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

      <div className="mac-controls-safe-left sticky top-0 z-20 mb-6 flex w-full shrink-0 items-center gap-3 bg-background/95 px-6 pt-2 pb-2 backdrop-blur-sm sm:px-10 lg:hidden">
        <div className="h-8" />
      </div>

      <div
        className={cn(
          "relative z-10 flex min-h-0 flex-1 flex-col items-center justify-start overflow-visible px-4 sm:px-6 lg:overflow-y-auto",
          className,
        )}
      >
        <div className="pointer-events-none absolute inset-0 opacity-70">
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#00000008_1px,transparent_1px),linear-gradient(to_bottom,#00000008_1px,transparent_1px)] bg-size-[52px_52px] dark:bg-[linear-gradient(to_right,#ffffff10_1px,transparent_1px),linear-gradient(to_bottom,#ffffff10_1px,transparent_1px)]" />
        </div>
        <div className="relative my-auto flex w-full justify-center pb-10 lg:py-10">
          {mounted ? children : null}
        </div>
      </div>
    </div>
  );
}
