"use client";

import { Alert, AlertDescription, Button, cn } from "@meshbot/design";
import type { DeviceView } from "@meshbot/types";
import { Loader2, Monitor } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "@/lib/api";
import { useDevices } from "@/rest/devices";
import { useCreateAgentDm } from "@/rest/im";

interface AgentPickerProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Agent picker：从「已授权且未吊销」的设备中选一个，创建（或复用）与其 Agent 的私信，
 * 成功后跳转 `/messages/:conversationId`。用 createPortal 渲染成居中弹窗，Esc / 点遮罩关闭。
 */
export function AgentPicker({ open, onClose }: AgentPickerProps) {
  const t = useTranslations("messagesSidebar");
  const router = useRouter();
  const { data: devices = [], isPending, error } = useDevices();
  const createDm = useCreateAgentDm();
  const [createError, setCreateError] = useState<string | null>(null);

  // 重新打开时清空上一次的报错，避免旧错误串场
  useEffect(() => {
    if (open) setCreateError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !createDm.isPending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, createDm.isPending, onClose]);

  if (!open || typeof document === "undefined") return null;

  const activeDevices = devices.filter((d) => d.revokedAt == null);

  const handlePick = async (device: DeviceView) => {
    if (createDm.isPending) return;
    setCreateError(null);
    try {
      const conv = await createDm.mutateAsync({ deviceId: device.id });
      onClose();
      router.push(`/messages/${conv.id}`);
    } catch (err) {
      setCreateError(
        err instanceof ApiError ? err.message : t("picker.createFailed"),
      );
    }
  };

  let body: ReactNode;
  if (error) {
    body = (
      <Alert variant="destructive">
        <AlertDescription>
          {error instanceof Error ? error.message : t("picker.loadFailed")}
        </AlertDescription>
      </Alert>
    );
  } else if (isPending) {
    body = (
      <div className="flex items-center gap-2 px-1 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("picker.loading")}
      </div>
    );
  } else if (activeDevices.length === 0) {
    body = (
      <div className="px-1 py-4 text-sm text-muted-foreground">
        {t("picker.empty")}
      </div>
    );
  } else {
    body = (
      <div className="flex max-h-[320px] flex-col gap-1 overflow-y-auto">
        {activeDevices.map((d) => (
          <button
            key={d.id}
            type="button"
            disabled={createDm.isPending}
            onClick={() => void handlePick(d)}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
              "hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-foreground">
                {d.name}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {d.platform}
              </span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="flex w-full max-w-[420px] flex-col gap-3 rounded-lg border border-border bg-background p-5 shadow-xl"
      >
        <div className="text-[15px] font-semibold text-foreground">
          {t("picker.title")}
        </div>
        <div className="text-[13px] leading-relaxed text-muted-foreground">
          {t("picker.description")}
        </div>
        {createError && (
          <Alert variant="destructive">
            <AlertDescription>{createError}</AlertDescription>
          </Alert>
        )}
        {body}
        <div className="mt-1 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={createDm.isPending}
            onClick={onClose}
          >
            {t("picker.cancel")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
