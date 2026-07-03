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
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { useDevices, useRevokeDevice } from "@/rest/devices";

/** 设备管理页：设备表（名称/平台/最近活跃/状态），行内「吊销」二次确认。 */
export default function DevicesSettingsPage() {
  const t = useTranslations("devices");
  const { data: devices = [], isPending, error } = useDevices();
  const revoke = useRevokeDevice();
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    await revoke.mutateAsync(revokeTarget);
    setRevokeTarget(null);
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
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((d) => {
                  const revoked = d.revokedAt != null;
                  return (
                    <TableRow
                      key={d.id}
                      className={cn(revoked && "opacity-50")}
                    >
                      <TableCell>{d.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {d.platform}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {d.lastSeenAt
                          ? new Date(d.lastSeenAt).toLocaleString()
                          : t("neverSeen")}
                      </TableCell>
                      <TableCell>
                        {revoked ? t("statusRevoked") : t("statusActive")}
                      </TableCell>
                      <TableCell className="text-right">
                        {revoked ? null : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={revoke.isPending}
                            onClick={() => setRevokeTarget(d.id)}
                          >
                            {t("revoke")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
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
        onConfirm={() => void confirmRevoke()}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}
