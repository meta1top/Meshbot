"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { Coffee, Palette, Terminal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { devicesAtom } from "@/atoms/devices";
import { addSessionAtom } from "@/atoms/sessions";
import { ChatInput } from "@/components/common/chat-input";
import { ComposerActions } from "@/components/common/composer-actions";
import { ModelSelect } from "@/components/common/model-select";
import { SuggestionChips } from "@/components/common/suggestion-chips";
import { ComposerTargetBar } from "@/components/home/composer-target-bar";
import { fetchRemoteRun, startRemoteRun } from "@/rest/remote-devices";
import { createSession } from "@/rest/session";

/** 起手台中区：品牌大标题 + 场景分段 + 建议 chips + 重 composer；发送即建会话跳转。 */
export function LauncherHome() {
  const t = useTranslations("home");
  const tChat = useTranslations("chatInput");
  const router = useRouter();
  const addSession = useSetAtom(addSessionAtom);
  const devices = useAtomValue(devicesAtom);
  const [draft, setDraft] = useState("");
  /** 起手台选中的模型配置 id；null = 默认（首个 enabled）。 */
  const [modelConfigId, setModelConfigId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [targetDeviceId, setTargetDeviceId] = useState<string | null>(null);
  const targetDevice = devices.find((d) => d.id === targetDeviceId) ?? null;

  /**
   * L3：选中远程 agent（非本机）时发送 → 走远程 run 隧道（mode=create），
   * 而非本地 createSession。B 新建的会话 id 不再靠轮询 B 的会话列表兜底
   * 发现，而是轮询 A 本机的 `fetchRemoteRun`（B 首帧一到，A 端点即回填
   * sessionId，近乎即时）——同时把本次 run 的 streamId 一并带到 URL，供
   * 刚打开的远程会话视图在「尚未发送过第二条消息」前仍能中断这第一轮 run
   * （该 streamId 是当前唯一能路由到 B 的凭证）。
   */
  const sendToRemoteDevice = async (deviceId: string, text: string) => {
    const { streamId } = await startRemoteRun(deviceId, {
      mode: "create",
      content: text,
    });
    // 轮询 A 本机（近乎即时：B 首帧一到 onFrame 即回填 sessionId）
    let sessionId: string | null = null;
    for (let i = 0; i < 40 && !sessionId; i++) {
      const run = await fetchRemoteRun(deviceId, { streamId });
      sessionId = run?.sessionId ?? null;
      if (!sessionId) await new Promise((r) => setTimeout(r, 250));
    }
    if (!sessionId) {
      throw new Error("远程会话未在预期时间内创建（目标设备可能已离线）");
    }
    router.push(
      `/assistant?remoteDevice=${deviceId}&id=${sessionId}&streamId=${streamId}`,
    );
  };

  const handleSend = async (text: string) => {
    if (sending || !text.trim()) return;
    setSending(true);
    try {
      if (targetDevice && !targetDevice.isCurrent) {
        await sendToRemoteDevice(targetDevice.id, text);
        return;
      }
      const res = await createSession(
        text,
        undefined,
        modelConfigId ?? undefined,
      );
      addSession(res.session);
      router.push(`/assistant?id=${res.sessionId}`);
    } catch (err) {
      console.error("发送失败", err);
      setSending(false); // 失败留在起手台，草稿由 ChatInput 已清——保守起见不自动重填
    }
  };

  // 场景分段（视觉占位，本地 state 切高亮，不接功能）
  const [scene, setScene] = useState("daily");
  const scenes = [
    { key: "daily", label: t("scenes.daily"), icon: Coffee },
    { key: "code", label: t("scenes.code"), icon: Terminal },
    { key: "design", label: t("scenes.design"), icon: Palette },
  ];

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="flex w-full max-w-[600px] flex-col items-start gap-5">
        <div>
          <h1 className="text-[40px] font-extrabold leading-[1.08] tracking-tight text-foreground">
            MeshBot
            <br />
            {t("slogan")}
          </h1>
        </div>
        {/* 场景分段（视觉占位） */}
        <div className="inline-flex gap-1 rounded-xl bg-(--shell-sidebar) p-1">
          {scenes.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setScene(s.key)}
              className={
                scene === s.key
                  ? "flex items-center gap-1.5 rounded-lg bg-(--shell-chrome) px-4 py-1.5 text-[13px] font-semibold text-white"
                  : "flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-[13px] font-semibold text-(--shell-sidebar-fg)/60 hover:text-(--shell-sidebar-fg)"
              }
            >
              <s.icon className="h-3.5 w-3.5" />
              {s.label}
            </button>
          ))}
        </div>
        {/* 建议 chips：点击填入草稿 */}
        <SuggestionChips onPick={(s) => setDraft(s)} />
        {/* composer：暖色圆角底板（WorkBuddy 式层次）包裹 ChatInput（动作栏内含
            技能/连应用/权限 + 上传 + 发送）+ 下方目标选择器行 */}
        <div className="w-full rounded-2xl bg-(--shell-sidebar) p-2.5">
          <ChatInput
            trailingActions={
              <ModelSelect value={modelConfigId} onChange={setModelConfigId} />
            }
            value={draft}
            onChange={setDraft}
            onSend={(text) => void handleSend(text)}
            isLoading={sending}
            placeholder={t("inputPlaceholders.0")}
            leadingActions={<ComposerActions />}
            labels={{
              attachment: tChat("attachment"),
              interrupt: tChat("interrupt"),
              send: tChat("send"),
            }}
          />
          <ComposerTargetBar
            selectedDeviceId={targetDeviceId}
            onSelectDevice={setTargetDeviceId}
          />
        </div>
      </div>
    </div>
  );
}
