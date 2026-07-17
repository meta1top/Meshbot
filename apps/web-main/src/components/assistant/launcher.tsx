"use client";

import { cn } from "@meshbot/design";
import { SessionLauncher } from "@meshbot/web-common/session";
import { ChevronRight, MonitorSmartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { stashLauncherDraft } from "@/lib/launcher-draft";
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
 * `useDevices()` 按 `agent.deviceId` 反查）。在线态从宿主设备派生的打磨
 * （灰掉离线 Agent）留 2c，本期下拉不做在线过滤——功能可用即可。
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
  const deviceNameById = new Map((devices ?? []).map((d) => [d.id, d.name]));
  const agentRows = (agents ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    deviceName: deviceNameById.get(a.deviceId) ?? a.deviceId,
  }));

  const [draft, setDraft] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [modelConfigId, setModelConfigId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 只有一个已注册 Agent 时默认选中（多个不预选，避免误发到错误 Agent）。
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || agentId || agentRows.length !== 1) return;
    autoPicked.current = true;
    setAgentId(agentRows[0].id);
  }, [agentRows, agentId]);

  const handleSend = (text: string) => {
    if (!text.trim()) return;
    if (!agentId) {
      setError(t("launcher.pickAgentFirst"));
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
 * composer 面板内、输入框下方的目标选择条（对位 web-agent 的 ComposerTargetBar
 * 「本地 › 默认工作区」）：web-main 这里选的是「哪个远程 Agent 执行」，选项
 * 副标题显示宿主设备名。在线态派生（灰掉离线宿主设备上的 Agent）留 2c，
 * 本期恒可选——功能可用即可。
 */
function AgentTargetBar({
  agents,
  value,
  onChange,
  placeholder,
  error,
}: {
  agents: Array<{ id: string; name: string; deviceName: string }>;
  value: string | null;
  onChange: (id: string) => void;
  placeholder: string;
  error: string | null;
}) {
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
        <MonitorSmartphone className="h-3.5 w-3.5" />
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
          <div className="absolute bottom-full left-2 z-50 mb-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md">
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  onChange(a.id);
                  setOpen(false);
                }}
                className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted"
              >
                <span className="min-w-0 w-full truncate">{a.name}</span>
                <span className="min-w-0 w-full truncate text-[10px] text-muted-foreground">
                  {a.deviceName}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
