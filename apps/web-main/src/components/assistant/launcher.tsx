"use client";

import { cn } from "@meshbot/design";
import { ChatInput } from "@meshbot/web-common/session";
import { useQueries } from "@tanstack/react-query";
import { Bot, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { stashLauncherDraft } from "@/lib/launcher-draft";
import {
  deviceOnlineQueryKey,
  fetchDeviceOnline,
  useDevicePresenceSync,
} from "@/rest/agent-devices";
import { useDevices } from "@/rest/devices";

/**
 * `/assistant` 启动台（对齐 web-agent `launcher-home`）：居中 composer——
 * 输入框 + 目标设备选择，发送即在该设备上新建远程会话。
 *
 * web-main 无本机 agent，所以「agent 选择」只列已授权设备（离线不可选）。
 *
 * 发送不在本页直接建会话：web-main 是 L3 协议里真正的 A（浏览器），拿不到
 * web-agent 那种「轮询本机 server-agent 的 fetchRemoteRun 回填 sessionId」的
 * 能力（见 remote-session-view 的 fetchActiveRun 契约说明）。改为把草稿
 * stash 进 sessionStorage + 跳设备页，由 `RemoteSessionView` 已经能工作的
 * create 流程（`startNewRemoteSession` → 首帧回报 sessionId）接手发送——
 * 复用既有链路，不新造第二条建会话路径。
 */
export function Launcher() {
  const t = useTranslations("assistant");
  const tDevices = useTranslations("devices");
  const router = useRouter();
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
  const onlineDevices = devices.filter(
    (_, i) => onlineQueries[i]?.data?.online ?? false,
  );

  const [draft, setDraft] = useState("");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 只有一台在线设备时默认选中（多台不预选，避免误发到错误设备）。
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || deviceId) return;
    if (onlineDevices.length === 1) {
      autoPicked.current = true;
      setDeviceId(onlineDevices[0].id);
    }
  }, [onlineDevices, deviceId]);

  const target = devices.find((d) => d.id === deviceId) ?? null;

  const handleSend = (text: string) => {
    if (!text.trim()) return;
    if (!deviceId) {
      setError(t("launcher.pickDeviceFirst"));
      return;
    }
    setError(null);
    // 草稿交接给设备会话页（一次性 token，读即删）
    const token = stashLauncherDraft(text);
    setDraft("");
    router.push(`/assistant/${deviceId}?draft=${token}`);
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <div className="w-full max-w-[720px]">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--shell-accent)/12 text-(--shell-accent)">
            <Bot className="h-7 w-7" />
          </span>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">
            {t("launcher.title")}
          </h1>
          <p className="text-[13px] text-muted-foreground">
            {t("launcher.subtitle")}
          </p>
        </div>

        {/* composer：暖色圆角底板包裹 ChatInput（对齐 web-agent 启动台层次） */}
        <div className="rounded-2xl border border-border bg-(--shell-content) p-2 shadow-sm">
          <ChatInput
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            placeholder={t("launcher.placeholder")}
            // 本地专属项（技能/连应用/权限）远程模式不注入 → 隐藏
            trailingActions={
              <DevicePicker
                devices={devices.map((d, i) => ({
                  id: d.id,
                  name: d.name,
                  online: onlineQueries[i]?.data?.online ?? false,
                }))}
                value={deviceId}
                onChange={(id) => {
                  setDeviceId(id);
                  setError(null);
                }}
                placeholder={t("launcher.pickDevice")}
                offlineLabel={tDevices("offline")}
              />
            }
            labels={{
              attachment: t("input.attachment"),
              interrupt: t("input.stop"),
            }}
          />
        </div>

        {error && (
          <p className="mt-2 text-center text-[12px] text-destructive">
            {error}
          </p>
        )}
        {!error && target && (
          <p className="mt-2 text-center text-[12px] text-muted-foreground">
            {t("launcher.willRunOn", { device: target.name })}
          </p>
        )}
      </div>
    </div>
  );
}

/** 目标设备选择器：列已授权设备，离线不可选（置灰）。 */
function DevicePicker({
  devices,
  value,
  onChange,
  placeholder,
  offlineLabel,
}: {
  devices: Array<{ id: string; name: string; online: boolean }>;
  value: string | null;
  onChange: (id: string) => void;
  placeholder: string;
  offlineLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const current = devices.find((d) => d.id === value) ?? null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            current?.online ? "bg-[#16a34a]" : "bg-muted-foreground/30",
          )}
        />
        <span className="max-w-[160px] truncate">
          {current?.name ?? placeholder}
        </span>
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <>
          {/* 点外部关闭 */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 bottom-full z-50 mb-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md">
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
