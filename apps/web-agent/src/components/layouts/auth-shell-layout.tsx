"use client";

import { useTheme } from "@meshbot/web-common/react";
import { PreLoginShellView } from "@meshbot/web-common/shell";
import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { DragRegion } from "@/components/drag-region";
import { LanguageToggle } from "@/components/language-toggle";

interface AuthShellLayoutProps {
  children: React.ReactNode;
  className?: string;
}

/** 登录前 chrome 容器：注入 Electron 拖拽栏 + 主题/语言切换，body 走对话式单列壳。 */
export function AuthShellLayout({ children, className }: AuthShellLayoutProps) {
  const [mounted, setMounted] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const tCommon = useTranslations("common");

  useEffect(() => {
    document.body.classList.add("auth-shell-mode");
    setMounted(true);
    return () => {
      document.body.classList.remove("auth-shell-mode");
    };
  }, []);

  return (
    <PreLoginShellView
      className={className}
      topBar={
        <DragRegion
          actions={
            <div className="flex items-center gap-2">
              <LanguageToggle />
              <button
                type="button"
                onClick={toggleTheme}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-(--shell-sidebar-border) text-(--shell-sidebar-fg)/70 transition-colors hover:bg-(--shell-sidebar-hover)"
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
      }
    >
      {mounted ? children : null}
    </PreLoginShellView>
  );
}
