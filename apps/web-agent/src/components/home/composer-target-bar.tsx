"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@meshbot/design";
import { ChevronRight, FolderClosed } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { parseAgentAvatar } from "@/lib/agent-avatar";
import {
  buildLauncherOptions,
  type LauncherOption,
  type LauncherTarget,
  launcherTargetKey,
} from "@/lib/launcher-target";
import { useAgents } from "@/rest/agents";
import { useRemoteAgents } from "@/rest/remote-agents";

interface ComposerTargetBarProps {
  /** 当前选中目标；null = 未显式选择（视觉默认展示列表第一项，但发送逻辑由
   *  父组件按 value 是否为 null 决定是否兜底默认 Agent）。 */
  value: LauncherTarget | null;
  onChange: (target: LauncherTarget) => void;
}

/**
 * 起手台 composer 下方目标选择器行：本机 Agent + 其他设备的远程 Agent 合并成
 * 一个扁平下拉（本机在前、远程在后，D2）。远程项显示 Agent 名 + 宿主设备名
 * 副标题、离线宿主置灰不可选（D1/D3）。「设备」不再是目标。
 */
export function ComposerTargetBar({ value, onChange }: ComposerTargetBarProps) {
  const t = useTranslations("composer");
  const { data: localAgents } = useAgents();
  const { data: remoteAgents } = useRemoteAgents();

  const options = useMemo(
    () => buildLauncherOptions(localAgents, remoteAgents),
    [localAgents, remoteAgents],
  );

  const selectedKey = launcherTargetKey(value);
  const selected =
    options.find((o) => o.key === selectedKey) ?? options[0] ?? null;

  return (
    <div className="mt-2 flex items-center gap-4 px-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {selected ? <TargetAvatar avatar={selected.avatar} /> : null}
            {selected?.name ?? ""}
            <ChevronRight className="h-3 w-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[220px]">
          {options.map((o) => (
            <TargetItem key={o.key} option={o} onChange={onChange} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 选择工作空间：默认工作区（占位，后续接真实目录） */}
      <button
        type="button"
        title={t("comingSoon")}
        className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <FolderClosed className="h-3.5 w-3.5" />
        {t("workspaceDefault")}
        <ChevronRight className="h-3 w-3 opacity-60" />
      </button>
    </div>
  );
}

/** 圆形色底 emoji 头像（起手台目标行/下拉项共用）。 */
function TargetAvatar({ avatar }: { avatar: string }) {
  const { emoji, color } = parseAgentAvatar(avatar);
  return (
    <span
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px]"
      style={{ backgroundColor: color }}
    >
      {emoji}
    </span>
  );
}

/** 单个下拉项：本机=单行；远程=名字 + 宿主设备名副标题 + 离线灰化不可选。 */
function TargetItem({
  option,
  onChange,
}: {
  option: LauncherOption;
  onChange: (target: LauncherTarget) => void;
}) {
  const t = useTranslations("composer");
  return (
    <DropdownMenuItem
      disabled={option.disabled}
      onClick={() => onChange(option.target)}
      className="flex items-center gap-2"
    >
      <TargetAvatar avatar={option.avatar} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{option.name}</span>
        {option.subtitle ? (
          <span className="truncate text-[10px] text-muted-foreground">
            {option.online
              ? option.subtitle
              : t("hostOffline", { device: option.subtitle })}
          </span>
        ) : null}
      </span>
    </DropdownMenuItem>
  );
}
