"use client";

import { SessionLauncher } from "@meshbot/web-common/session";
import { useAtomValue, useSetAtom } from "jotai";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { currentAgentIdAtom } from "@/atoms/agent";
import { devicesAtom } from "@/atoms/devices";
import { addSessionAtom } from "@/atoms/sessions";
import { ComposerActions } from "@/components/common/composer-actions";
import { ModelSelect } from "@/components/common/model-select";
import { useSuggestions } from "@/components/common/suggestion-chips";
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
  const currentAgentId = useAtomValue(currentAgentIdAtom);
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
        currentAgentId ?? undefined,
      );
      addSession(res.session);
      router.push(`/assistant?id=${res.sessionId}`);
    } catch (err) {
      console.error("发送失败", err);
      setSending(false); // 失败留在起手台，草稿由 ChatInput 已清——保守起见不自动重填
    }
  };

  const suggestions = useSuggestions();

  return (
    <SessionLauncher
      draft={draft}
      onDraftChange={setDraft}
      onSend={(text) => void handleSend(text)}
      sending={sending}
      suggestions={suggestions}
      onPickSuggestion={setDraft}
      leadingActions={<ComposerActions />}
      trailingActions={
        <ModelSelect value={modelConfigId} onChange={setModelConfigId} />
      }
      targetBar={
        <ComposerTargetBar
          selectedDeviceId={targetDeviceId}
          onSelectDevice={setTargetDeviceId}
        />
      }
      labels={{
        brand: "MeshBot",
        slogan: t("slogan"),
        scenes: {
          daily: t("scenes.daily"),
          code: t("scenes.code"),
          design: t("scenes.design"),
        },
        placeholder: t("inputPlaceholders.0"),
        chatInput: {
          attachment: tChat("attachment"),
          interrupt: tChat("interrupt"),
          send: tChat("send"),
        },
      }}
    />
  );
}
