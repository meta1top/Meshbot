"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@meshbot/design";
import type { StatsRange, StatsResponse } from "@meshbot/types-agent";
import { useSetAtom } from "jotai";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { addSessionAtom } from "@/atoms/sessions";
import { ActivityHeatmap } from "@/components/common/activity-heatmap";
import {
  ChatInput,
  type ChatInputHandle,
} from "@/components/common/chat-input";
import { SuggestionChips } from "@/components/common/suggestion-chips";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { formatPeakHour, formatStreak } from "@/lib/format-stats";
import { formatTokens } from "@/lib/format-tokens";
import { createSession } from "@/rest/session";
import { fetchStats } from "@/rest/stats";

const RANGES: StatsRange[] = ["all", "30d", "7d"];

export default function Home() {
  const t = useTranslations("home");
  const router = useRouter();
  const addSession = useSetAtom(addSessionAtom);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<ChatInputHandle>(null);

  // 随机标题：首帧用第 0 条，挂载后随机替换，避免 SSR/CSR hydration mismatch
  const titles = (t.raw("titles") as string[]) ?? [t("title")];
  const [titleIdx, setTitleIdx] = useState(0);
  useEffect(() => {
    if (titles.length > 1) {
      setTitleIdx(Math.floor(Math.random() * titles.length));
    }
  }, [titles.length]);
  const title = titles[titleIdx] ?? t("title");

  // 输入框 placeholder：同样客户端挂载后随机选一条（首页才随机，session 视图用默认）
  const placeholders = (t.raw("inputPlaceholders") as string[]) ?? [];
  const [phIdx, setPhIdx] = useState(0);
  useEffect(() => {
    if (placeholders.length > 1) {
      setPhIdx(Math.floor(Math.random() * placeholders.length));
    }
  }, [placeholders.length]);
  const inputPlaceholder = placeholders[phIdx];

  // 真实 stats + range 筛选
  const [range, setRange] = useState<StatsRange>("all");
  const [stats, setStats] = useState<StatsResponse | null>(null);
  useEffect(() => {
    let alive = true;
    fetchStats(range)
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch(() => {
        if (alive) setStats(null);
      });
    return () => {
      alive = false;
    };
  }, [range]);

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

  const handlePickSuggestion = (text: string) => {
    setDraft(text);
    inputRef.current?.focus(text);
  };

  const metrics: Array<{
    label: string;
    value: string;
  }> = [
    { label: t("metrics.sessions"), value: String(stats?.sessions ?? 0) },
    { label: t("metrics.messages"), value: String(stats?.messages ?? 0) },
    {
      label: t("metrics.totalTokens"),
      value: stats ? formatTokens(stats.totalTokens) : "0",
    },
    { label: t("metrics.activeDays"), value: String(stats?.activeDays ?? 0) },
    {
      label: t("metrics.currentStreak"),
      value: formatStreak(stats?.currentStreak ?? 0),
    },
    {
      label: t("metrics.longestStreak"),
      value: formatStreak(stats?.longestStreak ?? 0),
    },
    {
      label: t("metrics.peakHour"),
      value: formatPeakHour(stats?.peakHour ?? null),
    },
    {
      label: t("metrics.favoriteModel"),
      value: stats?.favoriteModel ?? "—",
    },
  ];

  return (
    <AppShellLayout>
      <div className="w-full max-w-[620px] flex-1">
        <div className="mb-4 flex items-center gap-3">
          <Image
            src="/logo.svg"
            alt="meshbot"
            width={36}
            height={36}
            unoptimized
            className="shrink-0"
          />
          <h1 className="text-[38px] leading-none font-medium tracking-[-0.015em] text-foreground">
            {title}
          </h1>
        </div>

        <Card className="overflow-hidden border-border bg-muted px-1 py-1 shadow-none">
          <CardHeader className="space-y-2 px-3 pt-2 pb-1">
            <div className="flex items-center justify-end text-[11px] text-foreground/60">
              <div className="flex items-center gap-2">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRange(r)}
                    className={
                      r === range
                        ? "rounded-md bg-foreground/8 px-1.5 py-0.5 font-medium text-foreground"
                        : "px-1 py-0.5 text-foreground/60 hover:text-foreground"
                    }
                  >
                    {r === "all" ? t("all") : r}
                  </button>
                ))}
              </div>
            </div>
            <CardTitle className="sr-only">{t("overviewMetrics")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-3 pt-1 pb-3">
            <div className="grid grid-cols-4 gap-x-3 gap-y-2">
              {metrics.map((item) => (
                <div key={item.label} className="min-w-0">
                  <p className="text-[11px] text-foreground/55">{item.label}</p>
                  <p className="text-[18px] leading-tight font-semibold tracking-tight wrap-break-word text-foreground">
                    {item.value}
                  </p>
                </div>
              ))}
            </div>

            <ActivityHeatmap cells={stats?.heatmap ?? []} weeks={26} />
          </CardContent>
        </Card>
      </div>
      <div className="sticky bottom-4 mt-auto bg-background pt-4">
        <SuggestionChips onPick={handlePickSuggestion} />
        <ChatInput
          ref={inputRef}
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          isLoading={sending}
          placeholder={inputPlaceholder}
        />
      </div>
    </AppShellLayout>
  );
}
