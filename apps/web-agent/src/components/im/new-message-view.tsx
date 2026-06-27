"use client";

import { IM_WS_EVENTS } from "@meshbot/types";
import { useAtomValue, useSetAtom } from "jotai";
import { Hash, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { currentUserAtom } from "@/atoms/auth";
import { conversationsAtom, upsertConversationAtom } from "@/atoms/im";
import { addSessionAtom } from "@/atoms/sessions";
import { ChatInput } from "@/components/common/chat-input";
import { ChannelPicker } from "@/components/im/channel-picker";
import { useLlmusePrefix } from "@/hooks/use-llmuse-prefix";
import { getEventsSocket } from "@/lib/events-socket";
import { filterRecipients } from "@/lib/recipient-filter";
import { createDm } from "@/rest/im";
import { useMembers } from "@/rest/org";
import { createSession } from "@/rest/session";

type Recipient =
  | { kind: "channel"; id: string; label: string }
  | { kind: "member"; userId: string; label: string }
  | { kind: "session" };

export function NewMessageView() {
  const t = useTranslations("newMessage");
  const router = useRouter();
  const currentUser = useAtomValue(currentUserAtom);
  const conversations = useAtomValue(conversationsAtom);
  const upsertConversation = useSetAtom(upsertConversationAtom);
  const addSession = useSetAtom(addSessionAtom);

  const orgId = currentUser?.org?.id ?? null;
  const { data: members = [] } = useMembers(orgId);

  const prefix = useLlmusePrefix();
  const [query, setQuery] = useState("");
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const channels = useMemo(
    () => conversations.filter((c) => c.type === "channel"),
    [conversations],
  );
  const groups = useMemo(
    () => filterRecipients(query, channels, members, currentUser?.id ?? null),
    [query, channels, members, currentUser?.id],
  );

  const recipientLabel =
    recipient?.kind === "session" ? t("startSession") : recipient?.label;

  const handleSend = async (body: string) => {
    if (!recipient) return;
    if (recipient.kind === "session") {
      const res = await createSession(prefix(body));
      addSession(res.session);
      router.push(`/messages?kind=assistant&id=${res.sessionId}`);
      return;
    }
    if (recipient.kind === "channel") {
      getEventsSocket().emit(IM_WS_EVENTS.send, {
        conversationId: recipient.id,
        content: body,
      });
      router.push(`/messages?id=${recipient.id}`);
      return;
    }
    const conv = await createDm(recipient.userId);
    upsertConversation(conv);
    getEventsSocket().emit(IM_WS_EVENTS.send, {
      conversationId: conv.id,
      content: body,
    });
    router.push(`/messages?id=${conv.id}`);
  };

  return (
    <div className="flex w-full flex-1 flex-col">
      <div className="mb-3 text-[15px] font-bold text-foreground">
        {t("title")}
      </div>

      {/* 至： */}
      <div className="relative mb-4 flex items-center gap-2 border-b border-border pb-3">
        <span className="text-[13px] font-semibold text-muted-foreground">
          {t("toLabel")}
        </span>
        {recipient ? (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-(--shell-accent)/15 px-2 py-1 text-[13px] font-medium text-(--shell-accent)">
            {recipientLabel}
            <button
              type="button"
              onClick={() => setRecipient(null)}
              aria-label={t("toLabel")}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ) : (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("toPlaceholder")}
            className="flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        )}

        {!recipient && (
          <div className="absolute left-0 top-full z-20 mt-1 max-h-[360px] w-full max-w-[520px] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg">
            <div className="px-2.5 pt-2 pb-1 text-[11px] font-bold text-muted-foreground">
              {t("groupChannels")}
            </div>
            {groups.channels.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() =>
                  setRecipient({
                    kind: "channel",
                    id: c.id,
                    label: c.name ?? "",
                  })
                }
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] hover:bg-muted"
              >
                <Hash className="h-4 w-4 shrink-0 opacity-70" />
                <span className="truncate">{c.name}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-(--shell-accent) hover:bg-muted"
            >
              <span className="w-4 text-center">＋</span>
              {t("createChannel")}
            </button>

            <div className="px-2.5 pt-3 pb-1 text-[11px] font-bold text-muted-foreground">
              {t("groupMembers")}
            </div>
            {groups.members.map((m) => (
              <button
                key={m.userId}
                type="button"
                onClick={() =>
                  setRecipient({
                    kind: "member",
                    userId: m.userId,
                    label: m.displayName,
                  })
                }
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] hover:bg-muted"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-(--shell-accent) text-[10px] font-semibold text-white">
                  {m.displayName.charAt(0).toUpperCase()}
                </span>
                <span className="truncate">{m.displayName}</span>
              </button>
            ))}

            <div className="px-2.5 pt-3 pb-1 text-[11px] font-bold text-muted-foreground">
              {t("groupAssistant")}
            </div>
            <button
              type="button"
              onClick={() => setRecipient({ kind: "session" })}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-(--shell-accent) hover:bg-muted"
            >
              <Sparkles className="h-4 w-4 shrink-0" />
              {t("startSession")}
            </button>
          </div>
        )}
      </div>

      {/* 正文：选定收件人后启用 */}
      {recipient ? (
        <div className="mt-auto">
          <ChatInput
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            placeholder={t("bodyPlaceholder")}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
          {t("empty")}
        </div>
      )}

      <ChannelPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onNavigate={(id) => router.push(`/messages?id=${id}`)}
      />
    </div>
  );
}
