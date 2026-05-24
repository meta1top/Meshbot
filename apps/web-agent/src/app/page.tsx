"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@meshbot/design";
import { useSetAtom } from "jotai";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { addSessionAtom } from "@/atoms/sessions";
import { ActivityHeatmap } from "@/components/common/activity-heatmap";
import { ChatInput } from "@/components/common/chat-input";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { createSession } from "@/rest/session";

const heatmapData = Array.from({ length: 96 }, (_, index) =>
  index === 79 ? 100 : index % 5 === 0 ? 50 : 0,
);

export default function Home() {
  const t = useTranslations("home");
  const router = useRouter();
  const addSession = useSetAtom(addSessionAtom);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");

  /** 发送消息：创建新会话并跳转到会话页 */
  const handleSend = async (msg: string) => {
    if (sending) return;
    setSending(true);
    try {
      const { sessionId, session } = await createSession(msg);
      addSession(session);
      router.push(`/session?id=${sessionId}`);
    } catch (err) {
      console.error("创建会话失败", err);
      setSending(false);
    }
  };

  const metrics = [
    { label: t("metrics.sessions"), value: "3" },
    { label: t("metrics.messages"), value: "947" },
    { label: t("metrics.totalTokens"), value: "4.2M" },
    { label: t("metrics.activeDays"), value: "1" },
    { label: t("metrics.currentStreak"), value: "0d" },
    { label: t("metrics.longestStreak"), value: "1d" },
    { label: t("metrics.peakHour"), value: "6 PM" },
    { label: t("metrics.favoriteModel"), value: "GPT-4o" },
  ];

  return (
    <AppShellLayout>
      <div className="w-full max-w-[620px] flex-1">
        <div className="mb-4 flex items-center gap-2 text-[38px] leading-none">
          <h1 className="text-[38px] leading-none font-medium tracking-[-0.015em] text-foreground">
            {t("title")}
          </h1>
        </div>

        <Card className="overflow-hidden border-border bg-muted shadow-none">
          <CardHeader className="space-y-3 pb-2">
            <div className="flex items-center justify-end text-[12px] text-foreground/70">
              <div className="flex items-center gap-3">
                <span className="rounded-md bg-accent px-2 py-1 font-medium text-foreground">
                  {t("all")}
                </span>
                <span>30d</span>
                <span>7d</span>
              </div>
            </div>
            <CardTitle className="sr-only">{t("overviewMetrics")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-4 gap-1.5">
              {metrics.map((item) => (
                <div
                  key={item.label}
                  className="rounded-[6px] bg-accent px-2.5 py-2 text-foreground"
                >
                  <p className="text-[11px] text-card-foreground">
                    {item.label}
                  </p>
                  <p className="mt-1 text-[30px] leading-[0.95] font-medium tracking-tight">
                    {item.value}
                  </p>
                </div>
              ))}
            </div>

            <ActivityHeatmap data={heatmapData} maxValue={100} />
          </CardContent>
        </Card>
      </div>
      <div className="sticky bottom-4 mt-auto bg-background pt-4">
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          isLoading={sending}
        />
      </div>
    </AppShellLayout>
  );
}
