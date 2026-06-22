"use client";

import { cn } from "@meshbot/design";
import { BarChart3, Clock } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * 「更多」区左侧子导航（Slack 左对齐）：使用情况 + 定时任务。
 * 容器范式同 messages-sidebar；当前路由高亮。
 */
export function MoreSidebar() {
  const t = useTranslations("moreSidebar");
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
    <div className="flex h-full flex-col bg-(--shell-sidebar) text-white">
      <div className="flex h-11 shrink-0 items-center border-b border-white/8 px-3.5 text-[15px] font-extrabold">
        {t("title")}
      </div>
      <nav className="flex flex-col gap-0.5 px-2 py-2">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            onClick={() => router.push(it.href)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
              it.active
                ? "bg-(--shell-accent) text-white"
                : "text-white/75 hover:bg-white/12",
            )}
          >
            {it.icon}
            {it.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
