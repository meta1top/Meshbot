"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@meshbot/design";
import { useTranslations } from "next-intl";
import { ChatInput } from "@/components/common/chat-input";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";

const heatmapCells = Array.from({ length: 96 }, (_, index) => index);

export default function Home() {
  const t = useTranslations("home");
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
      <div className="mx-auto w-full max-w-[620px]">
        <div className="mb-4 flex items-center gap-2 text-[38px] leading-none">
          <span className="text-[20px] text-[#d97745]">✺</span>
          <h1 className="text-[38px] leading-none font-medium tracking-[-0.015em] text-foreground">
            {t("title")}
          </h1>
        </div>

        <Card className="overflow-hidden border-border bg-muted shadow-none">
          <CardHeader className="space-y-3 pb-2">
            <div className="flex items-center justify-between text-[12px] text-foreground/70">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-accent px-2 py-1 font-medium text-foreground">
                  {t("overview")}
                </span>
                <span>{t("models")}</span>
              </div>
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
                  <p className="text-[11px] text-muted-foreground">
                    {item.label}
                  </p>
                  <p className="mt-1 text-[30px] leading-[0.95] font-medium tracking-tight">
                    {item.value}
                  </p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-16 gap-1">
              {heatmapCells.map((cell) => (
                <span
                  key={cell}
                  className="h-5 rounded-[3px] bg-accent"
                  style={
                    cell === 79 ? { backgroundColor: "#3b82f6" } : undefined
                  }
                />
              ))}
            </div>

            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{t("tokenComparison")}</span>
              <div className="h-8 w-2 rounded bg-accent" />
            </div>
          </CardContent>
        </Card>
      </div>
      <div className="mt-8">
        <ChatInput
          onSend={(msg) => console.log("send:", msg)}
          tokenUsage={{ current: 12, max: 128 }}
        />
      </div>
    </AppShellLayout>
  );
}
