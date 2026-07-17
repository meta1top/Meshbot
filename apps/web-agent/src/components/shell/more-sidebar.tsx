"use client";

import {
  type NavGroup,
  SidebarHeader,
  SidebarNav,
} from "@meshbot/web-common/shell";
import { BarChart3, Bot, Clock, Workflow } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * 「更多」区左侧二级导航：流程 + 使用情况 + 模型 + 定时任务。
 * 容器范式同 messages-sidebar；当前路由高亮。
 */
export function MoreSidebar() {
  const t = useTranslations("settingsSidebar");
  const tRail = useTranslations("appShell");
  const router = useRouter();
  const pathname = usePathname();

  const activeKey = pathname.startsWith("/flows")
    ? "flows"
    : pathname.startsWith("/schedule")
      ? "scheduled"
      : pathname.startsWith("/more/models")
        ? "models"
        : pathname === "/more"
          ? "usage"
          : undefined;

  const groups: NavGroup[] = [
    {
      key: "more",
      items: [
        {
          key: "flows",
          label: tRail("rail.flows"),
          icon: <Workflow />,
          onClick: () => router.push("/flows"),
        },
        {
          key: "usage",
          label: t("usage"),
          icon: <BarChart3 />,
          onClick: () => router.push("/more"),
        },
        {
          key: "models",
          label: t("models"),
          icon: <Bot />,
          onClick: () => router.push("/more/models"),
        },
        {
          key: "scheduled",
          label: t("scheduled"),
          icon: <Clock />,
          onClick: () => router.push("/schedule"),
        },
      ],
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <SidebarHeader title={tRail("rail.more")} />
      <nav className="flex flex-col px-3 py-2">
        <SidebarNav groups={groups} activeKey={activeKey} />
      </nav>
    </div>
  );
}
