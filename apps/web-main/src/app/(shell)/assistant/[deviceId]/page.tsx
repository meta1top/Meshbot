"use client";

import { Card, CardContent, cn, Skeleton } from "@meshbot/design";
import { PageShellView } from "@meshbot/web-common/shell";
import { Monitor } from "lucide-react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { DeviceSublist } from "@/components/assistant/device-sublist";
import { useDeviceOnline, useDevicePresenceSync } from "@/rest/agent-devices";
import { useDevices } from "@/rest/devices";

/**
 * 设备详情占位页（二期远程会话留位）：名称/平台/在线状态/最后活跃 + 占位条。
 * 设备不存在（未找到/已吊销/加载失败）与设备离线是两种不同的文案分支——前者
 * 整页替换为「设备不存在」空态，后者仍渲染完整详情卡（在线态字段本身即显示离线），
 * 仅底部占位条文案额外提示需设备在线才能发起远程会话。
 */
export default function AssistantDevicePage() {
  const t = useTranslations("assistant");
  const tDevices = useTranslations("devices");
  const params = useParams<{ deviceId: string }>();
  const deviceId = params.deviceId;
  const { data: devices, isPending, error } = useDevices();
  const { data: onlineData } = useDeviceOnline(deviceId);
  useDevicePresenceSync();

  const device = devices?.find((d) => d.id === deviceId);
  const notFound = !isPending && (error || !device || device.revokedAt != null);
  const online = onlineData?.online ?? false;

  return (
    <>
      <DeviceSublist />
      <PageShellView>
        {isPending ? (
          <DeviceDetailSkeleton />
        ) : notFound ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Monitor className="h-7 w-7" />
            </span>
            <div className="text-[15px] font-semibold text-foreground">
              {t("notFoundTitle")}
            </div>
            <div className="max-w-[320px] text-[13px] text-muted-foreground">
              {t("notFoundHint")}
            </div>
          </div>
        ) : (
          device && (
            <div className="flex flex-1 items-center justify-center">
              <Card className="w-full max-w-sm">
                <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
                  <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--shell-accent)/12 text-(--shell-accent)">
                    <Monitor className="h-7 w-7" />
                  </span>
                  <div className="text-[15px] font-semibold text-foreground">
                    {device.name}
                  </div>
                  <dl className="w-full space-y-2 text-left text-[13px]">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">
                        {tDevices("colPlatform")}
                      </dt>
                      <dd className="text-foreground">{device.platform}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">
                        {tDevices("colOnline")}
                      </dt>
                      <dd className="flex items-center gap-2 text-foreground">
                        <span
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            online
                              ? "bg-[#16a34a]"
                              : "bg-(--shell-sidebar-fg)/30",
                          )}
                        />
                        {online ? tDevices("online") : tDevices("offline")}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">
                        {tDevices("colLastSeen")}
                      </dt>
                      <dd className="text-foreground">
                        {device.lastSeenAt
                          ? new Date(device.lastSeenAt).toLocaleString()
                          : tDevices("neverSeen")}
                      </dd>
                    </div>
                  </dl>
                  <div className="w-full rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
                    {online
                      ? t("remoteSessionComingSoon")
                      : t("remoteSessionOfflineHint")}
                  </div>
                </CardContent>
              </Card>
            </div>
          )
        )}
      </PageShellView>
    </>
  );
}

/** 详情卡骨架：贴近真实卡片形状（图标圆 + 标题条 + 三行字段 + 占位条）。 */
function DeviceDetailSkeleton() {
  return (
    <div className="flex flex-1 items-center justify-center" aria-hidden>
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col items-center gap-4 py-8">
          <Skeleton className="h-14 w-14 rounded-2xl" />
          <Skeleton className="h-4 w-32" />
          <div className="w-full space-y-2">
            {["platform", "online", "lastSeen"].map((field) => (
              <div key={field} className="flex items-center justify-between">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-20" />
              </div>
            ))}
          </div>
          <Skeleton className="h-8 w-full rounded-md" />
        </CardContent>
      </Card>
    </div>
  );
}
