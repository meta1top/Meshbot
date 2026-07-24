"use client";

import { cn } from "@meshbot/design";
import { SessionLauncher } from "@meshbot/web-common/session";
import { useQueries } from "@tanstack/react-query";
import { ChevronRight, MonitorSmartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseAgentAvatar } from "@/lib/agent-avatar";
import {
  buildLauncherAgentRows,
  pickDefaultAgentId,
} from "@/lib/launcher-agent-rows";
import { stashLauncherDraft } from "@/lib/launcher-draft";
import {
  deviceOnlineQueryKey,
  fetchDeviceOnline,
  useDevicePresenceSync,
} from "@/rest/agent-devices";
import { useAgents } from "@/rest/agents";
import { useProfile } from "@/rest/auth";
import { useDevices } from "@/rest/devices";
import { ComposerActions } from "./composer-actions";
import { RemoteModelSelect } from "./remote-model-select";

/**
 * `/assistant` 起手台：渲染与 web-agent 同一个共享 `SessionLauncher`
 * （品牌大标题 + 场景分段 + 建议 chips + 暖色 composer 面板），只把
 * 「本地/工作区」目标条换成「Agent 选择」——web-main 无本机 agent，任务必须
 * 交给一个已注册的远程 Agent（`GET /api/agents`，T2）。技能/连应用/权限
 * （本地专属）远程模式不注入即隐藏。
 *
 * 计划二 2b · T7：寻址主键从设备细化到 Agent（`targetAgentId`），下拉数据源
 * 从「设备列表」换成「Agent 列表」，选项显示 Agent 名 + 宿主设备名（配合
 * `useDevices()` 按 `agent.deviceId` 反查）。
 *
 * 计划二 2c · F1：在线态从宿主设备派生（`deviceOnlineQueryKey` +
 * `fetchDeviceOnline`，和 `assistant-sidebar.tsx` 同一份 presence 数据源）——
 * 离线 Agent 灰化 + 下拉项 `disabled` 不可选、默认选中不预选一个离线目标、
 * 发送前二次拦截（选中后宿主转离线的边界）。三重防线对齐 D1/D3：不能让用户
 * 选中并发到一个无监听 device room 的目标，那样只会在会话页 idle-timeout
 * 失败，而不是像侧栏一样在源头拦住。
 *
 * 发送不在本页建会话：web-main 是 L3 的 A（浏览器），没有 web-agent 那种
 * 「轮询本机 server-agent 的 fetchRemoteRun 回填 sessionId」的能力。改为把草稿
 * stash 进 sessionStorage（一次性 token，读即删）+ 跳 Agent 会话页，由
 * `RemoteSessionView` 已能工作的 create 流程接手发送，复用既有链路。
 */
export function Launcher() {
  const t = useTranslations("assistant");
  const router = useRouter();
  const profile = useProfile();
  const orgId = profile.data?.activeOrg?.id ?? null;

  const { data: agents } = useAgents();
  const { data: devices } = useDevices();
  const deviceNameById = useMemo(
    () => new Map((devices ?? []).map((d) => [d.id, d.name])),
    [devices],
  );

  // 每个 Agent 宿主设备的在线态——与 assistant-sidebar.tsx 同一份 presence
  // 数据源（deviceOnlineQueryKey + fetchDeviceOnline，实时更新靠下面的
  // useDevicePresenceSync 订阅），离线宿主的 Agent 灰化 + 禁选（F1）：不做的话
  // 用户能选中一个无监听 device room 的目标，跳会话页后远程 run 只会
  // idle-timeout 失败，而不是像侧栏那样在源头拦住。
  useDevicePresenceSync();
  const agentList = useMemo(() => agents ?? [], [agents]);
  const distinctDeviceIds = useMemo(
    () => [...new Set(agentList.map((a) => a.deviceId))],
    [agentList],
  );
  const onlineQueries = useQueries({
    queries: distinctDeviceIds.map((deviceId) => ({
      queryKey: deviceOnlineQueryKey(deviceId),
      queryFn: () => fetchDeviceOnline(deviceId),
      staleTime: 30_000,
    })),
  });
  const onlineByDevice = new Map(
    distinctDeviceIds.map((id, i) => [
      id,
      onlineQueries[i]?.data?.online ?? false,
    ]),
  );
  const agentRows = buildLauncherAgentRows(
    agentList,
    deviceNameById,
    onlineByDevice,
  );

  const [draft, setDraft] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [modelConfigId, setModelConfigId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 只有一个已注册 Agent、且宿主在线时才默认选中（多个不预选，避免误发到
  // 错误 Agent；唯一那个若离线，也不能默认选中一个发不出去的目标）。
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || agentId) return;
    const defaultId = pickDefaultAgentId(agentRows);
    if (!defaultId) return;
    autoPicked.current = true;
    setAgentId(defaultId);
  }, [agentRows, agentId]);

  const handleSend = (text: string) => {
    if (!text.trim()) return;
    if (!agentId) {
      setError(t("launcher.pickAgentFirst"));
      return;
    }
    const current = agentRows.find((a) => a.id === agentId);
    if (!current?.online) {
      // 保险：选中后宿主设备转离线（presence 实时推送），发送前兜底拦住，
      // 别让离线 Agent 被发起——和 disabled 下拉项双重保障。
      setError(t("launcher.agentOffline"));
      return;
    }
    setError(null);
    const token = stashLauncherDraft(text);
    setDraft("");
    router.push(`/assistant/${agentId}?draft=${token}`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SessionLauncher
        draft={draft}
        onDraftChange={setDraft}
        onSend={handleSend}
        // 建议 chips：web-main 无后端建议接口，用 i18n 默认列表（空数组则隐藏）
        suggestions={[]}
        // 技能 / 连应用 / 权限：与 web-agent 同一份占位动作链（点击无副作用）
        leadingActions={<ComposerActions />}
        trailingActions={
          orgId ? (
            <RemoteModelSelect
              orgId={orgId}
              value={modelConfigId}
              onChange={setModelConfigId}
            />
          ) : undefined
        }
        targetBar={
          <AgentTargetBar
            agents={agentRows}
            value={agentId}
            onChange={(id) => {
              setAgentId(id);
              setError(null);
            }}
            placeholder={t("launcher.pickAgent")}
            error={error}
          />
        }
        labels={{
          brand: "MeshBot",
          slogan: t("launcher.slogan"),
          scenes: {
            daily: t("launcher.scenes.daily"),
            code: t("launcher.scenes.code"),
            design: t("launcher.scenes.design"),
          },
          placeholder: t("launcher.placeholder"),
          chatInput: {
            attachment: t("input.attachment"),
            interrupt: t("input.stop"),
          },
        }}
      />
    </div>
  );
}

/**
 * 圆形色底 emoji 头像（起手台目标条触发器 / 下拉项共用）。与侧栏 Agent 行
 * （`assistant-sidebar.tsx`）同一份 `avatar` 串、同一个 `parseAgentAvatar`
 * 解析口，保证「侧栏有头像、选择器没头像」的两处不一致不再出现。
 */
function AgentAvatarDot({ avatar }: { avatar: string }) {
  const { emoji, color } = parseAgentAvatar(avatar);
  return (
    <span
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]"
      style={{ backgroundColor: color }}
      aria-hidden
    >
      {emoji}
    </span>
  );
}

/**
 * composer 面板内、输入框下方的目标选择条（对位 web-agent 的 ComposerTargetBar
 * 「本地 › 默认工作区」）：web-main 这里选的是「哪个远程 Agent 执行」，选项
 * 副标题显示宿主设备名。计划二 2c · F1：`disabled` 离线项灰化 + 点击不触发
 * `onChange`（真拦选中，不只是视觉），副标题换成「设备名（离线）」提示。
 */
function AgentTargetBar({
  agents,
  value,
  onChange,
  placeholder,
  error,
}: {
  agents: Array<{
    id: string;
    name: string;
    avatar: string;
    deviceName: string;
    online: boolean;
    disabled: boolean;
  }>;
  value: string | null;
  onChange: (id: string) => void;
  placeholder: string;
  error: string | null;
}) {
  const t = useTranslations("assistant");
  const [open, setOpen] = useState(false);
  const current = agents.find((a) => a.id === value) ?? null;

  return (
    <div className="relative flex items-center gap-1 px-2 pt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] transition-colors hover:bg-muted",
          error
            ? "text-destructive"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {current ? (
          <AgentAvatarDot avatar={current.avatar} />
        ) : (
          <MonitorSmartphone className="h-3.5 w-3.5" />
        )}
        <span className="max-w-[220px] truncate">
          {current?.name ?? placeholder}
        </span>
        <ChevronRight className="h-3 w-3" />
      </button>
      {error && <span className="text-[12px] text-destructive">{error}</span>}

      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-full left-2 z-50 mb-1 max-h-64 w-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-md">
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={a.disabled}
                aria-disabled={a.disabled}
                onClick={() => {
                  if (a.disabled) return;
                  onChange(a.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                  a.disabled
                    ? "cursor-not-allowed text-muted-foreground/50"
                    : "text-foreground hover:bg-muted",
                )}
              >
                <AgentAvatarDot avatar={a.avatar} />
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="w-full min-w-0 truncate">{a.name}</span>
                  <span className="w-full min-w-0 truncate text-[10px] text-muted-foreground">
                    {a.online
                      ? a.deviceName
                      : t("launcher.hostOffline", { device: a.deviceName })}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
