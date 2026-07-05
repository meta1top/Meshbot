"use client";

import { cn } from "@meshbot/design";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

interface NavItem {
  href: string;
  labelKey: "org" | "devices" | "models";
}

const NAV_ITEMS: NavItem[] = [
  { href: "/settings/org", labelKey: "org" },
  { href: "/settings/devices", labelKey: "devices" },
  { href: "/settings/models", labelKey: "models" },
];

/** 左侧导航（组织/设备/模型），当前路径高亮。 */
function SettingsNav() {
  const t = useTranslations("settings");
  const pathname = usePathname();

  return (
    <nav className="flex w-48 shrink-0 flex-col gap-1 border-r border-border p-3">
      {NAV_ITEMS.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {t(`nav.${item.labelKey}`)}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * `/settings/*` 共享壳:左导航(组织/设备/模型)+ 内容,套白底内容卡。
 * 导航由 (shell) 持久壳的 rail 承担;鉴权由根 `Providers` 里的全局 `AuthGuard` 统一负责。
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0">
      <SettingsNav />
      <main className="min-w-0 flex-1 overflow-auto rounded-(--shell-radius) bg-(--shell-content) p-6">
        {children}
      </main>
    </div>
  );
}
