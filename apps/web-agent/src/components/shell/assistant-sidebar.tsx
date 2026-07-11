"use client";

import type { DeviceView } from "@meshbot/types";
import type { SessionSummary } from "@meshbot/types-agent";
import {
  type NavGroup,
  type NavNode,
  SidebarHeader,
  SidebarNav,
  SidebarRow,
  type SidebarRowProps,
  SidebarSkeleton,
} from "@meshbot/web-common/shell";
import { useAtomValue, useSetAtom } from "jotai";
import { Sparkles, SquarePen } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
  deviceOnlineAtom,
  devicesAtom,
  devicesStatusAtom,
  loadDevicesAtom,
  reprobeOnlineAtom,
} from "@/atoms/devices";
import {
  loadRemoteSessionsAtom,
  remoteSessionsAtom,
} from "@/atoms/remote-sessions";
import { sessionsAtom, sessionsStatusAtom } from "@/atoms/sessions";
import { loadSidebarAtom } from "@/atoms/sidebar";
import { SessionListItem } from "@/components/sidebar/session-list-item";
import { fetchDeviceOnline } from "@/rest/devices";

/**
 * 每个 NavNode.key 对应的渲染元数据。SidebarNav 只认 key，改名/删除/在线态/只读
 * 等富信息经此 map 在 renderRow / onExpand 里按 key 还原，避免把业务对象塞进
 * 共享的 NavNode 数据模型。
 */
type NodeMeta =
  | { kind: "device"; device: DeviceView; online: boolean; canExpand: boolean }
  | { kind: "localSession"; session: SessionSummary }
  | { kind: "remoteSession"; deviceId: string; session: SessionSummary }
  | { kind: "skeleton" }
  | { kind: "note"; text: string };

/**
 * 助手二级侧栏：设备 → 会话两级树。一级 = 该账号所有注册设备（本机 + 其他，带在线点），
 * 本机默认展开列本地会话（sessionsAtom），其他设备展开时按需拉远程会话
 * （remoteSessionsAtom）。设备列表 / 在线态 / 本地会话 / 远程会话的订阅与拉取逻辑
 * 全部留在本组件，只把「已装配好的递归树」交给 SidebarNav 渲染：
 *  - 设备行：renderRow 组合 SidebarRow（chevron + 在线点 + 设备名 + 离线徽标，
 *    离线不可展开置灰）；
 *  - 本地会话叶子：复用 SessionListItem（改名 / 删除 / 活动小红点原样保留）；
 *  - 远程会话叶子：只读，跳只读历史视图；
 *  - 远程按需拉取接在 onExpand（替代原 DeviceNode 的展开副作用）。
 */
export function AssistantSidebar() {
  const t = useTranslations("assistantSidebar");
  const router = useRouter();
  // 当前路由若指向远程会话（?remoteDevice=…&id=…），据此定向展开该设备节点
  // 并主动触发其会话列表懒加载——否则刷新后设备折叠、列表未拉，无从高亮。
  const urlRemoteDevice = useSearchParams().get("remoteDevice");
  const devices = useAtomValue(devicesAtom);
  const devicesStatus = useAtomValue(devicesStatusAtom);
  const online = useAtomValue(deviceOnlineAtom);
  const sessions = useAtomValue(sessionsAtom);
  const sessionsStatus = useAtomValue(sessionsStatusAtom);
  const remoteSessions = useAtomValue(remoteSessionsAtom);
  const loadDevices = useSetAtom(loadDevicesAtom);
  const loadSidebar = useSetAtom(loadSidebarAtom);
  const reprobeOnline = useSetAtom(reprobeOnlineAtom);
  const loadRemoteSessions = useSetAtom(loadRemoteSessionsAtom);
  const setDeviceOnline = useSetAtom(deviceOnlineAtom);

  useEffect(() => {
    void loadSidebar();
    void loadDevices();
  }, [loadSidebar, loadDevices]);

  // URL 指向的远程设备：主动拉会话列表（defaultOpen 只影响树的展开态，
  // 不会走用户交互的 onExpand 回调，懒加载需在此显式触发）。
  useEffect(() => {
    if (urlRemoteDevice) void loadRemoteSessions(urlRemoteDevice);
  }, [urlRemoteDevice, loadRemoteSessions]);

  // Fix2 兜底：设备非干净退出时云端 presence 靠 45s TTL 静默过期、不发离线事件，
  // 侧栏可见期间周期重探在线态纠正之（真正的实时离线事件属服务端后续改进）。
  useEffect(() => {
    const timer = setInterval(() => void reprobeOnline(), 25_000);
    return () => clearInterval(timer);
  }, [reprobeOnline]);

  // 边装配树边登记每个 key 的渲染元数据（同一次 render 内，renderRow/onExpand 复用）。
  const metaByKey = new Map<string, NodeMeta>();

  // 装配某设备的会话子节点。子节点数组恒非空（loading/空/错误各给一个占位节点），
  // 以保证设备节点 hasChildren=true——chevron 常驻、onExpand 可触发，与原
  // DeviceNode「离线也显示 chevron」「展开才拉远程」一致。
  const buildChildren = (d: DeviceView): NavNode[] => {
    if (d.isCurrent) {
      if (sessionsStatus === "idle" || sessionsStatus === "loading") {
        metaByKey.set(`ph:${d.id}:load`, { kind: "skeleton" });
        return [{ key: `ph:${d.id}:load`, label: "" }];
      }
      if (sessions.length === 0) {
        metaByKey.set(`ph:${d.id}:empty`, { kind: "note", text: t("empty") });
        return [{ key: `ph:${d.id}:empty`, label: "" }];
      }
      return sessions.map((s) => {
        metaByKey.set(`s:${s.id}`, { kind: "localSession", session: s });
        return { key: `s:${s.id}`, label: s.title };
      });
    }
    const rs = remoteSessions[d.id];
    if (!rs || rs.status === "loading") {
      metaByKey.set(`ph:${d.id}:load`, { kind: "skeleton" });
      return [{ key: `ph:${d.id}:load`, label: "" }];
    }
    if (rs.status === "error") {
      metaByKey.set(`ph:${d.id}:err`, {
        kind: "note",
        text: t("remoteLoadFailed"),
      });
      return [{ key: `ph:${d.id}:err`, label: "" }];
    }
    if (rs.sessions.length === 0) {
      metaByKey.set(`ph:${d.id}:empty`, {
        kind: "note",
        text: t("remoteEmpty"),
      });
      return [{ key: `ph:${d.id}:empty`, label: "" }];
    }
    return rs.sessions.map((s) => {
      metaByKey.set(`r:${d.id}:${s.id}`, {
        kind: "remoteSession",
        deviceId: d.id,
        session: s,
      });
      return { key: `r:${d.id}:${s.id}`, label: s.title };
    });
  };

  const deviceNodes: NavNode[] = devices
    .filter((d) => !d.revokedAt)
    .map((d) => {
      const isOnline = d.isCurrent || (online[d.id] ?? false);
      const children = buildChildren(d);
      metaByKey.set(`dev:${d.id}`, {
        kind: "device",
        device: d,
        online: isOnline,
        canExpand: isOnline,
      });
      return {
        key: `dev:${d.id}`,
        label: d.isCurrent ? `${d.name}（${t("thisDevice")}）` : d.name,
        defaultOpen: d.isCurrent || d.id === urlRemoteDevice,
        children,
      };
    });

  const groups: NavGroup[] = [{ key: "devices", items: deviceNodes }];

  // 展开远程设备：按需拉会话列表 + 重探一次在线态（借「用户主动关心这台设备」
  // 的信号刷新在线态，比等下次整页重探更及时）。本机 / 离线设备不触发。
  const handleExpand = (node: NavNode) => {
    const meta = metaByKey.get(node.key);
    if (meta?.kind !== "device") return;
    if (meta.device.isCurrent || !meta.canExpand) return;
    const id = meta.device.id;
    void loadRemoteSessions(id);
    fetchDeviceOnline(id)
      .then((v) => setDeviceOnline((m) => ({ ...m, [id]: v })))
      .catch(() => {
        // 探测失败保留原在线态，不强行判离线（避免网络抖动误判）
      });
  };

  const renderRow = (node: NavNode, defaults: SidebarRowProps) => {
    const meta = metaByKey.get(node.key);
    if (!meta) return <SidebarRow {...defaults} />;
    switch (meta.kind) {
      case "device": {
        const row = (
          <SidebarRow
            icon={
              <>
                {defaults.icon}
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${meta.online ? "bg-[#16a34a]" : "bg-(--shell-sidebar-fg)/30"}`}
                />
              </>
            }
            label={
              <span className="font-semibold text-(--shell-sidebar-fg)">
                {node.label}
              </span>
            }
            depth={defaults.depth}
            trailing={
              !meta.online && !meta.device.isCurrent ? (
                <span className="shrink-0 text-[11px] text-(--shell-sidebar-fg)/50">
                  {t("offline")}
                </span>
              ) : undefined
            }
            onClick={meta.canExpand ? defaults.onClick : undefined}
          />
        );
        return meta.canExpand ? (
          row
        ) : (
          <div className="pointer-events-none opacity-50">{row}</div>
        );
      }
      case "localSession":
        return (
          <SessionListItem session={meta.session} depth={defaults.depth} />
        );
      case "remoteSession":
        return (
          <RemoteSessionItem
            deviceId={meta.deviceId}
            session={meta.session}
            depth={defaults.depth}
          />
        );
      case "skeleton":
        return <SidebarSkeleton />;
      case "note":
        return (
          <div
            className="py-1 pr-2 text-[12px] text-(--shell-sidebar-fg)/55"
            style={{ paddingLeft: `${8 + (defaults.depth ?? 0) * 14}px` }}
          >
            {meta.text}
          </div>
        );
    }
  };

  return (
    <div className="flex h-full flex-col">
      <SidebarHeader
        title={t("title")}
        action={
          <button
            type="button"
            title={t("newSession")}
            onClick={() => router.push("/assistant")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-(--shell-sidebar-fg)/70 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
          >
            <SquarePen className="h-4 w-4" />
          </button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        {devicesStatus === "error" ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {t("devicesLoadFailed")}
          </div>
        ) : (
          <SidebarNav
            loading={devicesStatus === "idle" || devicesStatus === "loading"}
            groups={groups}
            onExpand={handleExpand}
            renderRow={renderRow}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 远程会话只读列表项。刻意不复用 SessionListItem——那个组件会导航到本地
 * `/assistant?id=` 并带改名 / 删除菜单，均不适用于远程只读场景。组合共享
 * SidebarRow（复用统一的高度 / 缩进 / 选中态 class），点击跳只读历史视图。
 */
function RemoteSessionItem({
  deviceId,
  session,
  depth = 0,
}: {
  deviceId: string;
  session: SessionSummary;
  depth?: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active =
    pathname === "/assistant" &&
    searchParams.get("remoteDevice") === deviceId &&
    searchParams.get("id") === session.id;

  return (
    <SidebarRow
      icon={<Sparkles className="text-(--shell-sidebar-fg)/60" />}
      label={<span title={session.title}>{session.title}</span>}
      active={active}
      depth={depth}
      onClick={() =>
        router.push(`/assistant?remoteDevice=${deviceId}&id=${session.id}`)
      }
    />
  );
}
