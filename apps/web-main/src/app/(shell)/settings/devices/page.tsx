"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@meshbot/design";
import type { DeviceView } from "@meshbot/types";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ApiError } from "@/lib/api";
import { useDeviceOnline, useDevicePresenceSync } from "@/rest/agent-devices";
import { useDevices, useRevokeDevice } from "@/rest/devices";

/** 设备管理页：设备表（名称/平台/最近活跃/在线/授权状态），行内「吊销」二次确认。 */
export default function DevicesSettingsPage() {
  const t = useTranslations("devices");
  const { data: devices = [], isPending, error } = useDevices();
  const revoke = useRevokeDevice();
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // 在线态首屏靠逐行 useDeviceOnline，实时变化靠 presence 事件写缓存。
  useDevicePresenceSync();

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevokeError(null);
    try {
      await revoke.mutateAsync(revokeTarget);
      setRevokeTarget(null);
    } catch (err) {
      // 失败保持弹窗打开展示错误，可重试 / 取消
      setRevokeError(err instanceof ApiError ? err.message : t("revokeFailed"));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {error instanceof Error ? error.message : t("loadFailed")}
              </AlertDescription>
            </Alert>
          ) : isPending ? (
            <div className="text-sm text-muted-foreground">{t("loading")}</div>
          ) : devices.length === 0 ? (
            <div className="text-sm text-muted-foreground">{t("empty")}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colName")}</TableHead>
                  <TableHead>{t("colPlatform")}</TableHead>
                  <TableHead>{t("colLastSeen")}</TableHead>
                  <TableHead>{t("colOnline")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((d) => (
                  <DeviceRow
                    key={d.id}
                    device={d}
                    revoking={revoke.isPending}
                    onRevoke={() => {
                      setRevokeError(null);
                      setRevokeTarget(d.id);
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={revokeTarget != null}
        title={t("revokeConfirmTitle")}
        description={t("revokeConfirmDescription")}
        confirmText={t("revoke")}
        cancelText={t("cancel")}
        loading={revoke.isPending}
        destructive
        error={revokeError}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => {
          setRevokeTarget(null);
          setRevokeError(null);
        }}
      />
    </div>
  );
}

interface DeviceRowProps {
  device: DeviceView;
  revoking: boolean;
  onRevoke: () => void;
}

/**
 * 单台设备行：名称/平台/最近活跃/在线态/授权状态 + 吊销按钮。
 * 在线态首屏走 `useDeviceOnline`（已吊销设备不查询、直接显示占位），
 * 实时变化由页面级 `useDevicePresenceSync` 写入的 presence 缓存驱动。
 */
function DeviceRow({ device, revoking, onRevoke }: DeviceRowProps) {
  const t = useTranslations("devices");
  const revoked = device.revokedAt != null;
  // 已吊销设备传空 id 关闭在线态查询（useDeviceOnline 的 enabled 守卫）。
  const { data } = useDeviceOnline(revoked ? "" : device.id);
  const online = data?.online ?? false;

  return (
    <TableRow className={cn(revoked && "opacity-50")}>
      <TableCell>{device.name}</TableCell>
      <TableCell className="text-muted-foreground">{device.platform}</TableCell>
      <TableCell className="text-muted-foreground">
        {device.lastSeenAt
          ? new Date(device.lastSeenAt).toLocaleString()
          : t("neverSeen")}
      </TableCell>
      <TableCell>
        {revoked ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="flex items-center gap-2 text-muted-foreground">
            <span
              className={cn(
                "h-2.5 w-2.5 shrink-0 rounded-full",
                online ? "bg-green-500" : "bg-muted-foreground/40",
              )}
            />
            {online ? t("online") : t("offline")}
          </span>
        )}
      </TableCell>
      <TableCell>{revoked ? t("statusRevoked") : t("statusActive")}</TableCell>
      <TableCell className="text-right">
        {revoked ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={revoking}
            onClick={onRevoke}
          >
            {t("revoke")}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
