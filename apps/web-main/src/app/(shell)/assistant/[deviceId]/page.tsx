"use client";

import { Card, CardContent, Skeleton } from "@meshbot/design";
import { PageShellView } from "@meshbot/web-common/shell";
import { Monitor } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense } from "react";
import { DeviceSublist } from "@/components/assistant/device-sublist";
import { RemoteSessionView } from "@/components/assistant/remote-session-view";
import { SessionSublist } from "@/components/assistant/session-sublist";
import { useDeviceOnline, useDevicePresenceSync } from "@/rest/agent-devices";
import { useProfile } from "@/rest/auth";
import { useDevices } from "@/rest/devices";

/**
 * 设备详情页：在线 → 完整远程会话界面（会话子栏 + `RemoteSessionView`）；
 * 离线 → 设备详情卡（在线态字段已显示离线）+ 禁止输入的提示；设备不存在
 * （未找到/已吊销/加载失败）→ 空态。`?session=` 决定当前查看/新建的会话
 * （无该参数 = 展示「新建会话」态输入框），`?streamId=` 只在本页自己刚发起
 * create 后由 `RemoteSessionView.onSessionCreated` 写入，用于把首轮
 * running/interrupt 路由带过去——直接导航进一个已有会话（点会话列表 /
 * 刷新页面）时天然没有这个参数，重连活跃流不在 V1 范围（见任务报告）。
 */
export default function AssistantDevicePage() {
  return (
    <Suspense fallback={null}>
      <AssistantDeviceView />
    </Suspense>
  );
}

function AssistantDeviceView() {
  const t = useTranslations("assistant");
  const tDevices = useTranslations("devices");
  const params = useParams<{ deviceId: string }>();
  const deviceId = params.deviceId;
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session");
  const streamId = searchParams.get("streamId");
  const router = useRouter();
  const { data: devices, isPending, error } = useDevices();
  const { data: onlineData } = useDeviceOnline(deviceId);
  useDevicePresenceSync();
  const profile = useProfile();
  const orgId = profile.data?.activeOrg?.id ?? null;

  const device = devices?.find((d) => d.id === deviceId);
  const notFound = !isPending && (error || !device || device.revokedAt != null);
  const online = onlineData?.online ?? false;

  return (
    <>
      {isPending || notFound ? (
        <DeviceSublist />
      ) : (
        <SessionSublist
          deviceId={deviceId}
          deviceName={device?.name ?? ""}
          online={online}
          activeSessionId={sessionId}
        />
      )}

      {isPending ? (
        <PageShellView>
          <DeviceDetailSkeleton />
        </PageShellView>
      ) : notFound ? (
        <PageShellView>
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
        </PageShellView>
      ) : !online ? (
        <PageShellView>
          {device && (
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
                        <span className="h-2 w-2 shrink-0 rounded-full bg-(--shell-sidebar-fg)/30" />
                        {tDevices("offline")}
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
                    {t("remoteSessionOfflineHint")}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </PageShellView>
      ) : !orgId ? (
        <PageShellView>
          <DeviceDetailSkeleton />
        </PageShellView>
      ) : (
        <RemoteSessionView
          key={deviceId}
          deviceId={deviceId}
          sessionId={sessionId}
          streamId={streamId}
          orgId={orgId}
          onSessionCreated={(newSessionId, newStreamId) =>
            router.replace(
              `/assistant/${deviceId}?session=${newSessionId}&streamId=${newStreamId}`,
            )
          }
        />
      )}
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
