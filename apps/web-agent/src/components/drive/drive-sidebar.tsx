"use client";

import { SidebarNavItem } from "@meshbot/web-common/shell";
import { HardDrive, Users } from "lucide-react";
import { useTranslations } from "next-intl";

export type DriveTab = "mine" | "shared";

interface Props {
  activeTab: DriveTab;
  onSelect: (tab: DriveTab) => void;
}

const TABS = [
  { tab: "mine" as const, icon: <HardDrive />, labelKey: "tabMine" as const },
  { tab: "shared" as const, icon: <Users />, labelKey: "tabShared" as const },
];

/** 文件页侧栏：我的文件 / 共享给我的（与更多/技能页同款一级导航项）。 */
export function DriveSidebar({ activeTab, onSelect }: Props) {
  const t = useTranslations("drive");

  return (
    <div className="flex h-full flex-col bg-(--shell-sidebar) text-white">
      <div className="flex h-11 shrink-0 items-center border-b border-white/8 px-3.5 text-[15px] font-extrabold">
        {t("title")}
      </div>
      <nav className="flex flex-col gap-0.5 px-2 py-2">
        {TABS.map(({ tab, icon, labelKey }) => (
          <SidebarNavItem
            key={tab}
            icon={icon}
            label={t(labelKey)}
            active={activeTab === tab}
            onClick={() => onSelect(tab)}
          />
        ))}
      </nav>
    </div>
  );
}
