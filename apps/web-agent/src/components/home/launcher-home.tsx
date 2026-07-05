"use client";

import { useSetAtom } from "jotai";
import {
  Blocks,
  ChevronDown,
  Coffee,
  Link2,
  Palette,
  Shield,
  Terminal,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { addSessionAtom } from "@/atoms/sessions";
import { ChatInput } from "@/components/common/chat-input";
import { SuggestionChips } from "@/components/common/suggestion-chips";
import { createSession } from "@/rest/session";

/** 起手台中区：品牌大标题 + 场景分段 + 建议 chips + 重 composer；发送即建会话跳转。 */
export function LauncherHome() {
  const t = useTranslations("home");
  const router = useRouter();
  const addSession = useSetAtom(addSessionAtom);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async (text: string) => {
    if (sending || !text.trim()) return;
    setSending(true);
    try {
      const res = await createSession(text);
      addSession(res.session);
      router.push(`/assistant?id=${res.sessionId}`);
    } catch {
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
      <div className="flex w-full max-w-[600px] flex-col items-center gap-5">
        <div className="text-center">
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
        {/* 重 composer：配置条（视觉占位）+ ChatInput */}
        <div className="w-full">
          <div className="mb-1.5 flex items-center gap-1.5">
            {[
              {
                key: "skills",
                icon: <Blocks className="h-3.5 w-3.5" />,
                label: t("composer.skills"),
              },
              {
                key: "apps",
                icon: <Link2 className="h-3.5 w-3.5" />,
                label: t("composer.apps"),
              },
              {
                key: "perms",
                icon: <Shield className="h-3.5 w-3.5" />,
                label: t("composer.permissions"),
              },
            ].map((c) => (
              <button
                key={c.key}
                type="button"
                title={t("composer.comingSoon")}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-muted-foreground hover:text-foreground"
              >
                {c.icon}
                {c.label}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            ))}
          </div>
          <ChatInput
            minimal
            value={draft}
            onChange={setDraft}
            onSend={(text) => void handleSend(text)}
            isLoading={sending}
            placeholder={t("inputPlaceholders.0")}
          />
        </div>
      </div>
    </div>
  );
}
