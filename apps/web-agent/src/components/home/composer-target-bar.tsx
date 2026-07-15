"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@meshbot/design";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronRight, FolderClosed, MonitorSmartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import {
  deviceOnlineAtom,
  devicesAtom,
  loadDevicesAtom,
} from "@/atoms/devices";
import { parseAgentAvatar } from "@/lib/agent-avatar";
import { useAgents } from "@/rest/agents";

/**
 * 起手台目标：二选一——发到本机某个 Agent（本地会话），或发到某台远程设备
 * （L3 隧道）。判别式联合，避免「agentId/deviceId 都可能非空」的歧义态。
 */
export type ComposerTarget =
  | { kind: "agent"; id: string }
  | { kind: "device"; id: string };

interface ComposerTargetBarProps {
  /** 当前选中目标；null = 未显式选择（视觉上仍展示列表第一个 Agent 作为
   * 默认态，但发送逻辑不会把这个默认当作用户显式选择——由父组件决定传
   * undefined 让后端兜底默认 Agent）。 */
  value: ComposerTarget | null;
  onChange: (target: ComposerTarget) => void;
}

/**
 * 起手台 composer 下方目标选择器行：
 * 选择目标（本机 Agent 扁平下拉 + 其他设备分区）+ 选择工作空间（占位）。
 * 与助手侧栏共用 devicesAtom / useAgents，两区排布与侧栏「上区本机 Agent /
 * 下区其他设备」一致。选中项状态提升到父组件 LauncherHome（发送逻辑需要
 * 据此判断走本地 createSession 还是 L3 远程 run）。
 */
export function ComposerTargetBar({ value, onChange }: ComposerTargetBarProps) {
  const t = useTranslations("composer");
  const { data: agents } = useAgents();
  const devices = useAtomValue(devicesAtom);
  const online = useAtomValue(deviceOnlineAtom);
  const loadDevices = useSetAtom(loadDevicesAtom);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const remoteDevices = useMemo(
    () => devices.filter((d) => !d.revokedAt && !d.isCurrent),
    [devices],
  );

  const selectedAgent =
    value?.kind === "agent"
      ? (agents?.find((a) => a.id === value.id) ?? null)
      : null;
  const selectedDevice =
    value?.kind === "device"
      ? (remoteDevices.find((d) => d.id === value.id) ?? null)
      : null;
  // 未显式选中设备时，视觉默认落到 Agent 列表第一个（不代表已选中——发送时
  // 父组件按 value 本身是否为 null 判断是否传 agentId 给后端）。
  const displayAgent =
    selectedAgent ?? (!selectedDevice ? (agents?.[0] ?? null) : null);

  return (
    <div className="mt-2 flex items-center gap-4 px-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {selectedDevice ? (
              <MonitorSmartphone className="h-3.5 w-3.5" />
            ) : displayAgent ? (
              (() => {
                const { emoji, color } = parseAgentAvatar(displayAgent.avatar);
                return (
                  <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px]"
                    style={{ backgroundColor: color }}
                  >
                    {emoji}
                  </span>
                );
              })()
            ) : (
              <MonitorSmartphone className="h-3.5 w-3.5" />
            )}
            {selectedDevice ? selectedDevice.name : (displayAgent?.name ?? "")}
            <ChevronRight className="h-3 w-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[200px]">
          {(agents ?? []).map((a) => {
            const { emoji, color } = parseAgentAvatar(a.avatar);
            return (
              <DropdownMenuItem
                key={a.id}
                onClick={() => onChange({ kind: "agent", id: a.id })}
                className="flex items-center gap-2"
              >
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px]"
                  style={{ backgroundColor: color }}
                >
                  {emoji}
                </span>
                <span className="truncate">{a.name}</span>
              </DropdownMenuItem>
            );
          })}

          {remoteDevices.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                {t("otherDevices")}
              </DropdownMenuLabel>
              {remoteDevices.map((d) => {
                const isOnline = online[d.id] ?? false;
                return (
                  <DropdownMenuItem
                    key={d.id}
                    disabled={!isOnline}
                    onClick={() => onChange({ kind: "device", id: d.id })}
                    className="flex items-center gap-2"
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? "bg-[#16a34a]" : "bg-muted-foreground/40"}`}
                    />
                    <span className="truncate">{d.name}</span>
                  </DropdownMenuItem>
                );
              })}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 选择工作空间：默认工作区（agent 文件工作区，后续接真实目录） */}
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
