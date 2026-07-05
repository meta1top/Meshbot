"use client";

import { SidebarNavItem } from "@meshbot/web-common/shell";
import { BarChart3, Clock } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * 「设置」区左侧子导航（Slack 左对齐）：使用情况 + 定时任务。
 * 容器范式同 messages-sidebar；当前路由高亮。
 */
export function MoreSidebar() {
  const t = useTranslations("settingsSidebar");
  const router = useRouter();
  const pathname = usePathname();

  const items = [
    {
      key: "usage",
      label: t("usage"),
      icon: <BarChart3 className="h-4 w-4" />,
      href: "/more",
      active: pathname === "/more",
    },
    {
      key: "scheduled",
      label: t("scheduled"),
      icon: <Clock className="h-4 w-4" />,
      href: "/schedule",
      active: pathname.startsWith("/schedule"),
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center px-3.5 text-[15px] font-extrabold">
        {t("title")}
      </div>
      <nav className="flex flex-col gap-0.5 px-2 py-2">
        {items.map((it) => (
          <SidebarNavItem
            key={it.key}
            icon={it.icon}
            label={it.label}
            active={it.active}
            onClick={() => router.push(it.href)}
          />
        ))}
      </nav>
    </div>
  );
}
