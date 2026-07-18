"use client";

import { Card, CardContent, Skeleton } from "@meshbot/design";
import { PageShellView } from "@meshbot/web-common/shell";
import { useQueryClient } from "@tanstack/react-query";
import { Monitor } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";
import { RemoteSessionView } from "@/components/assistant/remote-session-view";
import { remoteSessionsQueryKey } from "@/hooks/use-remote-sessions";
import { useDeviceOnline, useDevicePresenceSync } from "@/rest/agent-devices";
import { useAgents } from "@/rest/agents";
import { useProfile } from "@/rest/auth";
import { useDevices } from "@/rest/devices";

/**
 * Agent 会话页（计划二 2b · T7：URL 主键从 `[deviceId]` 改 `[agentId]`，
 * 寻址按云端 Agent id）：在线（宿主设备在线，2c 才会做 Agent 粒度在线态派生）
 * → 完整远程会话界面（会话子栏 + `RemoteSessionView`）；离线 → 设备详情卡
 * （在线态字段已显示离线）+ 禁止输入的提示；Agent 不存在（未注册/已软删/
 * 宿主设备不存在或已吊销/加载失败）→ 空态。`?session=` 决定当前查看的会话；
 * 既无 `?session=` 也无 `?draft=`（起手台交接的建会话草稿）时重定向回
 * `/assistant` 起手台——「新建会话页」态已下线。
 *
 * 首轮 create 的 streamId（把 running/interrupt 路由带进刚建好的会话）**不再
 * 走 URL**，改为本组件的 `createdStreamId` state：URL 参数会被刷新 / 后退 /
 * 书签重放，而 streamId 是一次性交接凭证——那条流早已终止后再被读出来，
 * `useSessionStream` 会乐观置 `running=true` 却永远等不到终止帧，界面永久卡在
 * 「运行中」（停止按钮常亮 + 用户输入被 send() 的 I3 守卫吞掉）。state 只在本
 * 次页面生命周期内有效，刷新即归零；历史 URL 里残留的 `?streamId=` 一律忽略
 * 并就地 `router.replace` 清掉（见下方 effect）。
 *
 * 代价：create 首轮进行中立刻刷新会丢 interrupt 路由——重连活跃流本就不在 V1
 * 范围（web-main 侧 L3 协议没有按 sessionId 反查 streamId 的通道，
 * `lib/session-transport.ts` 的 `fetchActiveRun` 如实抛错）。
 *
 * `useDevices`/`useDeviceOnline` 仍按 Agent 的宿主设备（`agent.deviceId`）
 * 查询——设备在线态/详情字段（platform/lastSeenAt 等）本期仍来自 Device 行，
 * 按宿主设备派生 Agent 粒度在线态的打磨留 2c，这里是最小改：只把 URL 主键
 * 与 transport 寻址换成 agentId，设备详情展示逻辑原样保留。
 */
export default function AssistantAgentPage() {
  return (
    <Suspense fallback={null}>
      <AssistantAgentView />
    </Suspense>
  );
}

function AssistantAgentView() {
  const t = useTranslations("assistant");
  const tDevices = useTranslations("devices");
  const params = useParams<{ agentId: string }>();
  const agentId = params.agentId;
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session");
  /**
   * 本页自己刚 create 出来的一次性 streamId（见组件 JSDoc：不进 URL）。
   * 连同它所属的 sessionId 一起记——本页不随会话切换卸载，只记 streamId 的话，
   * 用户切到同一 Agent 的另一个会话时会被当成那个会话的初始流（乐观 running
   * 又卡死一次）。下面按 sessionId 匹配后才透传。
   */
  const [createdStream, setCreatedStream] = useState<{
    sessionId: string;
    streamId: string;
  } | null>(null);
  const createdStreamId =
    createdStream && createdStream.sessionId === sessionId
      ? createdStream.streamId
      : null;
  // 启动台交接来的一次性草稿 token（读即删，见 lib/launcher-draft.ts）
  const draftToken = searchParams.get("draft");
  const router = useRouter();
  const queryClient = useQueryClient();
  const {
    data: agents,
    isPending: agentsPending,
    error: agentsError,
  } = useAgents();
  const agent = agents?.find((a) => a.id === agentId);
  const deviceId = agent?.deviceId ?? "";
  const {
    data: devices,
    isPending: devicesPending,
    error: devicesError,
  } = useDevices();
  const { data: onlineData } = useDeviceOnline(deviceId);
  useDevicePresenceSync();
  const profile = useProfile();
  const orgId = profile.data?.activeOrg?.id ?? null;

  const device = devices?.find((d) => d.id === deviceId);
  const isPending = agentsPending || devicesPending;
  const notFound =
    !isPending &&
    (agentsError ||
      devicesError ||
      !agent ||
      !device ||
      device.revokedAt != null);
  const online = onlineData?.online ?? false;

  // 「新建会话页」态（无 session 也无草稿）已下线：新会话统一从起手台发起
  // （选 Agent + 写第一句），设备行不再有「新建」入口。直接输 URL / 旧书签落到
  // 这里的，送回起手台。带 ?draft= 的是起手台自己交接进来的建会话流程，放行。
  useEffect(() => {
    if (sessionId || draftToken) return;
    router.replace("/assistant");
  }, [sessionId, draftToken, router]);

  // 历史 URL（旧版本写入的书签 / 浏览器后退栈）里残留的 `?streamId=` 一律
  // 就地清掉：它是早已终止的流的一次性凭证，留着只会误导（本页已不再读它，
  // 但用户复制这条 URL 分享/收藏时不该带上一个陈旧的运行凭证）。
  useEffect(() => {
    if (!searchParams.has("streamId")) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("streamId");
    const qs = next.toString();
    router.replace(`/assistant/${agentId}${qs ? `?${qs}` : ""}`);
  }, [searchParams, router, agentId]);

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
                    {agent?.name ?? device.name}
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
          key={agentId}
          agentId={agentId}
          deviceId={deviceId}
          sessionId={sessionId}
          streamId={createdStreamId}
          draftToken={draftToken}
          orgId={orgId}
          onSessionCreated={(newSessionId, newStreamId) => {
            // 侧栏会话列表是 React Query 缓存——新建的远程会话不失效就不会出现，
            // 用户也就无法在树里定位/切回它。失效后重拉，activeKey 随即高亮。
            void queryClient.invalidateQueries({
              queryKey: remoteSessionsQueryKey(agentId),
            });
            // streamId 只进 state 不进 URL（见组件 JSDoc）：本页不卸载，
            // sessionId 从 null 变成新会话时 useSessionStream 会带着它重跑
            // 初始化，首轮的 running/interrupt 路由照常生效。
            setCreatedStream({
              sessionId: newSessionId,
              streamId: newStreamId,
            });
            router.replace(`/assistant/${agentId}?session=${newSessionId}`);
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
