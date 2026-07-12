"use client";

import { cn } from "@meshbot/design";
import { Boxes, Building2, MonitorSmartphone } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

interface NavItem {
  href: string;
  labelKey: "org" | "devices" | "models";
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/settings/org", labelKey: "org", icon: <Building2 /> },
  {
    href: "/settings/devices",
    labelKey: "devices",
    icon: <MonitorSmartphone />,
  },
  { href: "/settings/models", labelKey: "models", icon: <Boxes /> },
];

/** 左侧导航（组织/设备/模型），当前路径高亮；暖米浅壳与 rail 统一。 */
function SettingsNav() {
  const t = useTranslations("settings");
  const pathname = usePathname();

  return (
    <div className="flex h-full w-48 shrink-0 flex-col overflow-hidden rounded-l-(--shell-radius) bg-(--shell-sidebar) text-(--shell-sidebar-fg)">
      <div className="flex h-13 shrink-0 items-center border-b border-(--shell-sidebar-border) px-3.5 text-[15px] font-extrabold">
        {t("title")}
      </div>
      <nav className="flex flex-col gap-0.5 px-2 py-2">
        {NAV_ITEMS.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0",
                active
                  ? "bg-(--shell-content) text-(--shell-sidebar-fg) shadow-sm"
                  : "text-(--shell-sidebar-fg)/80 hover:bg-(--shell-sidebar-hover)",
              )}
            >
              {item.icon}
              <span className="min-w-0 flex-1 truncate">
                {t(`nav.${item.labelKey}`)}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
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
      <main className="min-w-0 flex-1 overflow-hidden rounded-r-(--shell-radius)">
        {children}
      </main>
    </div>
  );
}
