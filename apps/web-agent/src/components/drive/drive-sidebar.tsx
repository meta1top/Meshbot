"use client";

import { type NavGroup, SidebarNav } from "@meshbot/web-common/shell";
import { HardDrive, Users } from "lucide-react";
import { useTranslations } from "next-intl";

export type DriveTab = "mine" | "shared";

interface Props {
  activeTab: DriveTab;
  onSelect: (tab: DriveTab) => void;
}

export function DriveSidebar({ activeTab, onSelect }: Props) {
  const t = useTranslations("drive");
  const groups: NavGroup[] = [
    {
      key: "tabs",
      items: [
        {
          key: "mine",
          label: t("tabMine"),
          icon: <HardDrive />,
          onClick: () => onSelect("mine"),
        },
        {
          key: "shared",
          label: t("tabShared"),
          icon: <Users />,
          onClick: () => onSelect("shared"),
        },
      ],
    },
  ];
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center px-3 text-[15px] font-extrabold">
        {t("title")}
      </div>
      <nav className="flex flex-col px-3 py-2">
        <SidebarNav groups={groups} activeKey={activeTab} />
      </nav>
    </div>
  );
}
