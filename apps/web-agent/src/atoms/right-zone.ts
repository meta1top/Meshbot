"use client";

import { atom } from "jotai";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import { currentConversationAtom } from "@/atoms/im";

/** 右区 tab。quick=随手问(固定钉右,显示助手名字);artifact=预览(固定);members 等按内容动态。 */
export type RightTab = "quick" | "artifact" | "members";

/** 用户显式选中的上下文 tab(null=未显式选,取默认)。 */
export const selectedContextTabAtom = atom<RightTab | null>(null);

/** 派生:左侧上下文 tab(不含 quick——quick 固定钉右端)。
 *  - artifact(预览):固定常驻
 *  - members(成员):仅频道会话动态出现 */
export const availableContextTabsAtom = atom<RightTab[]>((get) => {
  const tabs: RightTab[] = ["artifact"];
  if (get(currentConversationAtom)?.type === "channel") tabs.push("members");
  return tabs;
});

/** 派生:实际生效的右区 tab。显式选择优先;否则有产物→预览;否则→随手问。 */
export const effectiveRightTabAtom = atom<RightTab>((get) => {
  const sel = get(selectedContextTabAtom);
  const ctx = get(availableContextTabsAtom);
  if (sel === "quick") return "quick";
  if (sel && ctx.includes(sel)) return sel;
  if (get(previewArtifactAtom)) return "artifact";
  return "quick";
});
