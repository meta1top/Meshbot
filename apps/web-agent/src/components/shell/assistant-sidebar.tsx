"use client";

import type { DeviceView } from "@meshbot/types";
import type { SessionSummary } from "@meshbot/types-agent";
import {
  SessionTree,
  type SessionTreeLabels,
  type SessionTreeNodeInfo,
} from "@meshbot/web-common/session";
import {
  type NavGroup,
  type NavNode,
  SidebarHeader,
} from "@meshbot/web-common/shell";
import { useAtomValue, useSetAtom } from "jotai";
import { SquarePen } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo } from "react";
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
import {
  clearScheduleActivityAtom,
  scheduleActivityAtom,
} from "@/atoms/schedule-activity";
import {
  deleteSessionAtom,
  renameSessionAtom,
  sessionsAtom,
  sessionsStatusAtom,
} from "@/atoms/sessions";
import { loadSidebarAtom } from "@/atoms/sidebar";
import { fetchDeviceOnline } from "@/rest/devices";

/** 本地会话 key 前缀（`s:<sessionId>`）。 */
const LOCAL_PREFIX = "s:";

/**
 * 助手二级侧栏：设备 → 会话两级树。一级 = 该账号所有注册设备（本机 + 其他，带在线点），
 * 本机默认展开列本地会话（sessionsAtom），其他设备展开时按需拉远程会话
 * （remoteSessionsAtom）。设备列表 / 在线态 / 本地会话 / 远程会话的订阅与拉取逻辑
 * 全部留在本组件（数据装配），实际树渲染 + 会话行（改名 / 删除 / 活动小红点 /
 * chevron / 自动展开高亮）交给共享 `SessionTree`（`@meshbot/web-common/session`）——
 * 与 web-main 复用同一份交互逻辑。
 */
export function AssistantSidebar() {
  const t = useTranslations("assistantSidebar");
  const tSessionMenu = useTranslations("appShell.sessionMenu");
  const tDeleteConfirm = useTranslations("appShell.deleteConfirm");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // 当前路由若指向远程会话（?remoteDevice=…&id=…），据此定向展开该设备节点
  // 并主动触发其会话列表懒加载——否则刷新后设备折叠、列表未拉，无从高亮。
  const urlRemoteDevice = searchParams.get("remoteDevice");
  const urlSessionId = searchParams.get("id");
  const devices = useAtomValue(devicesAtom);
  const devicesStatus = useAtomValue(devicesStatusAtom);
  const online = useAtomValue(deviceOnlineAtom);
  const sessions = useAtomValue(sessionsAtom);
  const sessionsStatus = useAtomValue(sessionsStatusAtom);
  const remoteSessions = useAtomValue(remoteSessionsAtom);
  const scheduleActivity = useAtomValue(scheduleActivityAtom);
  const loadDevices = useSetAtom(loadDevicesAtom);
  const loadSidebar = useSetAtom(loadSidebarAtom);
  const reprobeOnline = useSetAtom(reprobeOnlineAtom);
  const loadRemoteSessions = useSetAtom(loadRemoteSessionsAtom);
  const setDeviceOnline = useSetAtom(deviceOnlineAtom);
  const clearScheduleActivity = useSetAtom(clearScheduleActivityAtom);
  const rename = useSetAtom(renameSessionAtom);
  const removeSession = useSetAtom(deleteSessionAtom);

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

  // 当前激活会话对应的树 key：本地 `s:<id>`，远程 `r:<deviceId>:<id>`。两者 key
  // 前缀不同、互斥，可安全合一成单个 activeSessionKey 交给 SessionTree（驱动
  // 高亮 + 祖先设备分支自动展开）。
  const activeSessionKey =
    pathname === "/assistant" && urlSessionId
      ? urlRemoteDevice
        ? `r:${urlRemoteDevice}:${urlSessionId}`
        : `${LOCAL_PREFIX}${urlSessionId}`
      : undefined;

  // 边装配树边登记每个 key 的渲染元数据（同一次 render 内，nodeInfo 回读复用）。
  const metaByKey = new Map<string, SessionTreeNodeInfo>();

  // 装配某设备的会话子节点。子节点数组恒非空（loading/空/错误各给一个占位节点），
  // 以保证设备节点 hasChildren=true——chevron 常驻、onExpand 可触发，与原
  // DeviceNode「离线也显示 chevron」「展开才拉远程」一致。
  const buildChildren = (d: DeviceView): NavNode[] => {
    if (d.isCurrent) {
      if (sessionsStatus === "idle" || sessionsStatus === "loading") {
        metaByKey.set(`ph:${d.id}:load`, {
          kind: "placeholder",
          variant: "skeleton",
        });
        return [{ key: `ph:${d.id}:load`, label: "" }];
      }
      if (sessions.length === 0) {
        metaByKey.set(`ph:${d.id}:empty`, {
          kind: "placeholder",
          variant: "note",
        });
        return [{ key: `ph:${d.id}:empty`, label: t("empty") }];
      }
      return sessions.map((s) => {
        const key = `${LOCAL_PREFIX}${s.id}`;
        metaByKey.set(key, {
          kind: "session",
          title: s.title,
          editable: true,
          deletable: true,
          hasActivity: scheduleActivity.has(s.id),
        });
        return {
          key,
          label: s.title,
          onClick: () => {
            clearScheduleActivity(s.id);
            router.push(`/assistant?id=${s.id}`);
          },
        };
      });
    }
    const rs = remoteSessions[d.id];
    if (!rs || rs.status === "loading") {
      metaByKey.set(`ph:${d.id}:load`, {
        kind: "placeholder",
        variant: "skeleton",
      });
      return [{ key: `ph:${d.id}:load`, label: "" }];
    }
    if (rs.status === "error") {
      metaByKey.set(`ph:${d.id}:err`, { kind: "placeholder", variant: "note" });
      return [{ key: `ph:${d.id}:err`, label: t("remoteLoadFailed") }];
    }
    if (rs.sessions.length === 0) {
      metaByKey.set(`ph:${d.id}:empty`, {
        kind: "placeholder",
        variant: "note",
      });
      return [{ key: `ph:${d.id}:empty`, label: t("remoteEmpty") }];
    }
    return rs.sessions.map((s: SessionSummary) => {
      const key = `r:${d.id}:${s.id}`;
      metaByKey.set(key, { kind: "session", title: s.title });
      return {
        key,
        label: s.title,
        onClick: () =>
          router.push(`/assistant?remoteDevice=${d.id}&id=${s.id}`),
      };
    });
  };

  const deviceNodes: NavNode[] = devices
    .filter((d) => !d.revokedAt)
    .map((d) => {
      const isOnline = d.isCurrent || (online[d.id] ?? false);
      const children = buildChildren(d);
      metaByKey.set(`dev:${d.id}`, {
        kind: "device",
        online: isOnline,
        expandable: isOnline,
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
  // 的信号刷新在线态，比等下次整页重探更及时）。本机 / 离线设备不触发
  // （devices 数组里本机 isCurrent，离线设备 expandable=false 时 chevron 不可点，
  // SidebarNav 不会为它触发 onExpand）。
  const handleExpandDevice = (node: NavNode) => {
    const id = node.key.startsWith("dev:") ? node.key.slice(4) : undefined;
    if (!id) return;
    const device = devices.find((d) => d.id === id);
    if (!device || device.isCurrent) return;
    void loadRemoteSessions(id);
    fetchDeviceOnline(id)
      .then((v) => setDeviceOnline((m) => ({ ...m, [id]: v })))
      .catch(() => {
        // 探测失败保留原在线态，不强行判离线（避免网络抖动误判）
      });
  };

  const onRenameSession = useCallback(
    (node: NavNode, title: string) =>
      rename({ id: node.key.slice(LOCAL_PREFIX.length), title }),
    [rename],
  );

  const onDeleteSession = useCallback(
    async (node: NavNode) => {
      const id = node.key.slice(LOCAL_PREFIX.length);
      await removeSession(id);
      if (activeSessionKey === node.key) router.push("/assistant");
    },
    [removeSession, activeSessionKey, router],
  );

  const labels: SessionTreeLabels = useMemo(
    () => ({
      offline: t("offline"),
      rename: tSessionMenu("rename"),
      delete: tSessionMenu("delete"),
      deleteConfirmTitle: (title: string) => tDeleteConfirm("title", { title }),
      deleteConfirmDescription: tDeleteConfirm("description"),
      deleteConfirmConfirm: tDeleteConfirm("confirm"),
      deleteConfirmCancel: tDeleteConfirm("cancel"),
    }),
    [t, tSessionMenu, tDeleteConfirm],
  );

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
          <SessionTree
            loading={devicesStatus === "idle" || devicesStatus === "loading"}
            groups={groups}
            activeSessionKey={activeSessionKey}
            nodeInfo={(node) => metaByKey.get(node.key)}
            onExpandDevice={handleExpandDevice}
            onRenameSession={onRenameSession}
            onDeleteSession={onDeleteSession}
            labels={labels}
          />
        )}
      </div>
    </div>
  );
}
