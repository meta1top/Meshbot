"use client";

import { atom } from "jotai";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { currentConversationAtom } from "@/atoms/im";

/** 右区可选的 tab。quick=随手问（全局钉住）；其余为页面上下文 tab。 */
export type RightTab = "quick" | "artifact" | "tools" | "members";

/** 当前主助手会话 id（由 /assistant 页写入；非随手问会话）。 */
export const currentAssistantSessionIdAtom = atom<string | null>(null);

/**
 * 当前主助手会话的工具调用列表：由 AssistantConversationBody（持有唯一的
 * session stream 订阅）发布，ToolsPanel 只读，不再自行 useSessionStream——
 * session socket 是无 refcount 的模块单例，二次 subscribe/unsubscribe 会在
 * ToolsPanel 卸载时把唯一 socket 从房间踢出，冻结主会话的实时流。
 */
export const currentAssistantToolCallsAtom = atom<
  { toolCallId: string; toolName: string }[]
>([]);

/** 用户显式选中的上下文 tab（null=未显式选，取默认）。 */
export const selectedContextTabAtom = atom<RightTab | null>(null);

/** 派生：当前可用的上下文 tab 列表（不含 quick——quick 永远钉在右端）。
 *  - 有产物 → artifact
 *  - 在主助手会话 → tools
 *  - 在频道会话 → members
 */
export const availableContextTabsAtom = atom<RightTab[]>((get) => {
  const tabs: RightTab[] = [];
  if (get(previewArtifactAtom)) tabs.push("artifact");
  if (get(currentAssistantSessionIdAtom)) tabs.push("tools");
  if (get(currentConversationAtom)?.type === "channel") tabs.push("members");
  return tabs;
});

/** 派生：实际生效的右区 tab。优先用户显式选择（且仍可用），否则默认：
 *  有产物→artifact；否则有上下文→第一个；否则 quick。 */
export const effectiveRightTabAtom = atom<RightTab>((get) => {
  const sel = get(selectedContextTabAtom);
  const ctx = get(availableContextTabsAtom);
  if (sel === "quick") return "quick";
  if (sel && ctx.includes(sel)) return sel;
  if (get(previewArtifactAtom)) return "artifact";
  return ctx[0] ?? "quick";
});
