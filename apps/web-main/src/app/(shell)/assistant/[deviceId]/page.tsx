"use client";

import { Card, CardContent, Skeleton } from "@meshbot/design";
import { PageShellView } from "@meshbot/web-common/shell";
import { useQueryClient } from "@tanstack/react-query";
import { Monitor } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect } from "react";
import { RemoteSessionView } from "@/components/assistant/remote-session-view";
import { remoteSessionsQueryKey } from "@/hooks/use-remote-sessions";
import { useDeviceOnline, useDevicePresenceSync } from "@/rest/agent-devices";
import { useProfile } from "@/rest/auth";
import { useDevices } from "@/rest/devices";

/**
 * 设备详情页：在线 → 完整远程会话界面（会话子栏 + `RemoteSessionView`）；
 * 离线 → 设备详情卡（在线态字段已显示离线）+ 禁止输入的提示；设备不存在
 * （未找到/已吊销/加载失败）→ 空态。`?session=` 决定当前查看的会话；既无
 * `?session=` 也无 `?draft=`（起手台交接的建会话草稿）时重定向回 `/assistant`
 * 起手台——「新建会话页」态已下线。`?streamId=` 只在本页自己刚发起
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
  // 启动台交接来的一次性草稿 token（读即删，见 lib/launcher-draft.ts）
  const draftToken = searchParams.get("draft");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: devices, isPending, error } = useDevices();
  const { data: onlineData } = useDeviceOnline(deviceId);
  useDevicePresenceSync();
  const profile = useProfile();
  const orgId = profile.data?.activeOrg?.id ?? null;

  const device = devices?.find((d) => d.id === deviceId);
  const notFound = !isPending && (error || !device || device.revokedAt != null);
  const online = onlineData?.online ?? false;

  // 「新建会话页」态（无 session 也无草稿）已下线：新会话统一从起手台发起
  // （选设备 + 写第一句），设备行不再有「新建」入口。直接输 URL / 旧书签落到
  // 这里的，送回起手台。带 ?draft= 的是起手台自己交接进来的建会话流程，放行。
  useEffect(() => {
    if (sessionId || draftToken) return;
    router.replace("/assistant");
  }, [sessionId, draftToken, router]);

  // 侧栏（设备→会话展开树）由段 layout 的 AssistantSidebar 持久渲染，本页只出主区。
  return (
    <>
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
      ) : !orgId || (!sessionId && !draftToken) ? (
        // 后者是重定向回起手台的过渡帧：不挂 RemoteSessionView，免得白建一个
        // transport（三个 socket 监听器）又立刻卸载。
        <PageShellView>
          <DeviceDetailSkeleton />
        </PageShellView>
      ) : (
        <RemoteSessionView
          key={deviceId}
          deviceId={deviceId}
          sessionId={sessionId}
          streamId={streamId}
          draftToken={draftToken}
          orgId={orgId}
          onSessionCreated={(newSessionId, newStreamId) => {
            // 侧栏会话列表是 React Query 缓存——新建的远程会话不失效就不会出现，
            // 用户也就无法在树里定位/切回它。失效后重拉，activeKey 随即高亮。
            void queryClient.invalidateQueries({
              queryKey: remoteSessionsQueryKey(deviceId),
            });
            router.replace(
              `/assistant/${deviceId}?session=${newSessionId}&streamId=${newStreamId}`,
            );
          }}
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
