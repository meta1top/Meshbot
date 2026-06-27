"use client";

import { useSetAtom } from "jotai";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { addSessionAtom } from "@/atoms/sessions";
import {
  ChatInput,
  type ChatInputHandle,
} from "@/components/common/chat-input";
import { SuggestionChips } from "@/components/common/suggestion-chips";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { useLlmusePrefix } from "@/hooks/use-llmuse-prefix";
import { toI18nList } from "@/lib/i18n-list";
import { createSession } from "@/rest/session";

export default function AssistantHome() {
  const t = useTranslations("home");
  const router = useRouter();
  const addSession = useSetAtom(addSessionAtom);
  const prefix = useLlmusePrefix();
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<ChatInputHandle>(null);

  // 随机标题：首帧用第 0 条，挂载后随机替换，避免 SSR/CSR hydration mismatch。
  // 注意 sync-locales 用 dot 路径 flatten/unflatten，list 会落成 {"0":..,"1":..}
  // object（非 Array），t.raw 返回的是 object —— 必须 Object.values 取列表，
  // 否则 .length 是 undefined，永远落在 index 0，随机轮换形同虚设。
  const titles = toI18nList(t.raw("titles"), () => t("title"));
  const [titleIdx, setTitleIdx] = useState(0);
  useEffect(() => {
    if (titles.length > 1) {
      setTitleIdx(Math.floor(Math.random() * titles.length));
    }
  }, [titles.length]);
  const title = titles[titleIdx] ?? t("title");

  // 输入框 placeholder：同样客户端挂载后随机选一条（首页才随机，session 视图用默认）
  const placeholders = toI18nList(t.raw("inputPlaceholders"));
  const [phIdx, setPhIdx] = useState(0);
  useEffect(() => {
    if (placeholders.length > 1) {
      setPhIdx(Math.floor(Math.random() * placeholders.length));
    }
  }, [placeholders.length]);
  const inputPlaceholder = placeholders[phIdx];

  /** 发送消息：创建新会话并跳转到会话页 */
  const handleSend = async (msg: string) => {
    if (sending) return;
    setSending(true);
    try {
      const { sessionId, session } = await createSession(prefix(msg));
      addSession(session);
      router.push(`/messages?kind=assistant&id=${sessionId}`);
    } catch (err) {
      console.error("创建会话失败", err);
      setSending(false);
    }
  };

  const handlePickSuggestion = (text: string) => {
    setDraft(text);
    inputRef.current?.focus(text);
  };

  return (
    <AppShellLayout>
      <div className="mx-auto w-full max-w-[620px] flex-1">
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
