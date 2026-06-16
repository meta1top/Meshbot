"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { Hash, MessageSquare, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import {
  conversationsAtom,
  currentConversationIdAtom,
  loadConversationsAtom,
  presenceAtom,
} from "@/atoms/im";
import { ChannelPicker } from "./channel-picker";
import { DmPicker } from "./dm-picker";

export function ImSidebar() {
  const router = useRouter();
  const t = useTranslations("messages");

  const conversations = useAtomValue(conversationsAtom);
  const currentId = useAtomValue(currentConversationIdAtom);
  const presence = useAtomValue(presenceAtom);
  const loadConversations = useSetAtom(loadConversationsAtom);
  const setCurrentId = useSetAtom(currentConversationIdAtom);

  const [menuOpen, setMenuOpen] = useState(false);
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);
  const [dmPickerOpen, setDmPickerOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const channels = conversations.filter((c) => c.type === "channel");
  const dms = conversations.filter((c) => c.type === "dm");

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // 点击菜单外部关闭下拉菜单
  useEffect(() => {
    if (!menuOpen) return;
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  function navigate(id: string) {
    setCurrentId(id);
    router.push(`/messages?id=${id}`);
  }

  return (
    <>
      <div className="flex h-full flex-col bg-(--shell-sidebar) text-white">
        {/* Header */}
        <div className="relative flex h-11 shrink-0 items-center justify-between border-b border-white/15 px-3.5">
          <span className="text-[15px] font-extrabold">{t("title")}</span>

          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              title={t("newConversation")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-white/80 hover:bg-white/15 hover:text-white"
            >
              <Plus className="h-4 w-4" />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md bg-(--shell-sidebar) py-1 shadow-lg ring-1 ring-white/15">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setChannelPickerOpen(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-white/90 hover:bg-white/15"
                >
                  <Hash className="h-3.5 w-3.5" />
                  {t("newChannel")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setDmPickerOpen(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-white/90 hover:bg-white/15"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  {t("newDm")}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
          {/* Channels section */}
          <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-white/50">
            {t("channels")}
          </div>

          {channels.length === 0 && (
            <p className="px-2 py-1 text-[12px] text-white/40">{t("empty")}</p>
          )}

          {channels.map((conv) => {
            const active = conv.id === currentId;
            return (
              <button
                key={conv.id}
                type="button"
                onClick={() => navigate(conv.id)}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors ${
                  active
                    ? "bg-white/24 text-white"
                    : "text-white/80 hover:bg-white/12 hover:text-white"
                }`}
              >
                <Hash className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{conv.name}</span>
                {conv.unreadCount > 0 && (
                  <span className="shrink-0 rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                    {conv.unreadCount > 99 ? "99+" : conv.unreadCount}
                  </span>
                )}
              </button>
            );
          })}

          {/* DMs section */}
          <div className="mt-3 mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-white/50">
            {t("directMessages")}
          </div>

          {dms.length === 0 && (
            <p className="px-2 py-1 text-[12px] text-white/40">{t("empty")}</p>
          )}

          {dms.map((conv) => {
            const active = conv.id === currentId;
            const peerId = conv.peer?.userId ?? "";
            const online = presence[peerId] ?? false;
            const name = conv.peer?.displayName ?? conv.name ?? "";
            return (
              <button
                key={conv.id}
                type="button"
                onClick={() => navigate(conv.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors ${
                  active
                    ? "bg-white/24 text-white"
                    : "text-white/80 hover:bg-white/12 hover:text-white"
                }`}
              >
                {/* Presence dot */}
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-green-400" : "bg-white/30"}`}
                  title={online ? t("online") : undefined}
                />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {conv.unreadCount > 0 && (
                  <span className="shrink-0 rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                    {conv.unreadCount > 99 ? "99+" : conv.unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <ChannelPicker
        open={channelPickerOpen}
        onClose={() => setChannelPickerOpen(false)}
        onNavigate={(id) => navigate(id)}
      />

      <DmPicker
        open={dmPickerOpen}
        onClose={() => setDmPickerOpen(false)}
        onNavigate={(id) => navigate(id)}
      />
    </>
  );
}
