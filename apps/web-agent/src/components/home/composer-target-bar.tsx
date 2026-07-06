"use client";

import { ChevronDown, FolderClosed, MonitorSmartphone } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * 起手台 composer 顶部选择器行：选择 Agent（默认本地）+ 选择工作空间（默认工作区）。
 * L1 纯 UI 壳，无真实数据 / 无状态：其他设备与工作空间切换在 L2/后续接入。
 */
export function ComposerTargetBar() {
  const t = useTranslations("composer");
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      {/* 选择 Agent：默认本地（其他设备 L2 接入，暂 coming-soon 提示） */}
      <button
        type="button"
        title={t("agentComingSoon")}
        className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
      >
        <MonitorSmartphone className="h-3.5 w-3.5 text-(--shell-accent)" />
        {t("agentLocal")}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {/* 选择工作空间：默认工作区（agent 文件工作区，后续接真实目录） */}
      <button
        type="button"
        title={t("comingSoon")}
        className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <FolderClosed className="h-3.5 w-3.5" />
        {t("workspaceDefault")}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
    </div>
  );
}
