"use client";

import { cn } from "@meshbot/design";
import { SessionLauncher } from "@meshbot/web-common/session";
import { useQueries } from "@tanstack/react-query";
import { ChevronRight, MonitorSmartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { stashLauncherDraft } from "@/lib/launcher-draft";
import {
  deviceOnlineQueryKey,
  fetchDeviceOnline,
  useDevicePresenceSync,
} from "@/rest/agent-devices";
import { useProfile } from "@/rest/auth";
import { useDevices } from "@/rest/devices";
import { RemoteModelSelect } from "./remote-model-select";

/**
 * `/assistant` 起手台：渲染与 web-agent 同一个共享 `SessionLauncher`
 * （品牌大标题 + 场景分段 + 建议 chips + 暖色 composer 面板），只把
 * 「本地/工作区」目标条换成「设备选择」——web-main 无本机 agent，任务必须
 * 交给一台已授权在线设备。技能/连应用/权限（本地专属）远程模式不注入即隐藏。
 *
 * 发送不在本页建会话：web-main 是 L3 的 A（浏览器），没有 web-agent 那种
 * 「轮询本机 server-agent 的 fetchRemoteRun 回填 sessionId」的能力。改为把草稿
 * stash 进 sessionStorage（一次性 token，读即删）+ 跳设备页，由
 * `RemoteSessionView` 已能工作的 create 流程接手发送，复用既有链路。
 */
export function Launcher() {
  const t = useTranslations("assistant");
  const tDevices = useTranslations("devices");
  const router = useRouter();
  const profile = useProfile();
  const orgId = profile.data?.activeOrg?.id ?? null;

  const { data: allDevices } = useDevices();
  useDevicePresenceSync();
  const devices = (allDevices ?? []).filter((d) => !d.revokedAt);

  const onlineQueries = useQueries({
    queries: devices.map((d) => ({
      queryKey: deviceOnlineQueryKey(d.id),
      queryFn: () => fetchDeviceOnline(d.id),
      staleTime: 30_000,
    })),
  });
  const deviceRows = devices.map((d, i) => ({
    id: d.id,
    name: d.name,
    online: onlineQueries[i]?.data?.online ?? false,
  }));
  const onlineRows = deviceRows.filter((d) => d.online);

  const [draft, setDraft] = useState("");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [modelConfigId, setModelConfigId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 只有一台在线设备时默认选中（多台不预选，避免误发到错误设备）。
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || deviceId || onlineRows.length !== 1) return;
    autoPicked.current = true;
    setDeviceId(onlineRows[0].id);
  }, [onlineRows, deviceId]);

  const handleSend = (text: string) => {
    if (!text.trim()) return;
    if (!deviceId) {
      setError(t("launcher.pickDeviceFirst"));
      return;
    }
    setError(null);
    const token = stashLauncherDraft(text);
    setDraft("");
    router.push(`/assistant/${deviceId}?draft=${token}`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SessionLauncher
        draft={draft}
        onDraftChange={setDraft}
        onSend={handleSend}
        // 建议 chips：web-main 无后端建议接口，用 i18n 默认列表（空数组则隐藏）
        suggestions={[]}
        // 本地专属项（技能/连应用/权限）远程模式不注入 → 隐藏
        trailingActions={
          orgId ? (
            <RemoteModelSelect
              orgId={orgId}
              value={modelConfigId}
              onChange={setModelConfigId}
            />
          ) : undefined
        }
        targetBar={
          <DeviceTargetBar
            devices={deviceRows}
            value={deviceId}
            onChange={(id) => {
              setDeviceId(id);
              setError(null);
            }}
            placeholder={t("launcher.pickDevice")}
            offlineLabel={tDevices("offline")}
            error={error}
          />
        }
        labels={{
          brand: "MeshBot",
          slogan: t("launcher.slogan"),
          scenes: {
            daily: t("launcher.scenes.daily"),
            code: t("launcher.scenes.code"),
            design: t("launcher.scenes.design"),
          },
          placeholder: t("launcher.placeholder"),
          chatInput: {
            attachment: t("input.attachment"),
            interrupt: t("input.stop"),
          },
        }}
      />
    </div>
  );
}

/**
 * composer 面板内、输入框下方的目标选择条（对位 web-agent 的 ComposerTargetBar
 * 「本地 › 默认工作区」）：web-main 这里选的是「哪台设备的 Agent 执行」。
 */
function DeviceTargetBar({
  devices,
  value,
  onChange,
  placeholder,
  offlineLabel,
  error,
}: {
  devices: Array<{ id: string; name: string; online: boolean }>;
  value: string | null;
  onChange: (id: string) => void;
  placeholder: string;
  offlineLabel: string;
  error: string | null;
}) {
  const [open, setOpen] = useState(false);
  const current = devices.find((d) => d.id === value) ?? null;

  return (
    <div className="relative flex items-center gap-1 px-2 pt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] transition-colors hover:bg-muted",
          error
            ? "text-destructive"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <MonitorSmartphone className="h-3.5 w-3.5" />
        <span className="max-w-[220px] truncate">
          {current?.name ?? placeholder}
        </span>
        <ChevronRight className="h-3 w-3" />
      </button>
      {error && <span className="text-[12px] text-destructive">{error}</span>}

      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-full left-2 z-50 mb-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md">
            {devices.map((d) => (
              <button
                key={d.id}
                type="button"
                disabled={!d.online}
                onClick={() => {
                  onChange(d.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                  d.online
                    ? "text-foreground hover:bg-muted"
                    : "cursor-not-allowed text-muted-foreground/50",
                )}
              >
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    d.online ? "bg-[#16a34a]" : "bg-muted-foreground/30",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                {!d.online && (
                  <span className="shrink-0 text-[10px]">{offlineLabel}</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
