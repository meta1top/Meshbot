"use client";

import { atom } from "jotai";

import { conversationsAtom, sortConversations } from "@/atoms/im";
import {
  sessionsAtom,
  sessionsStatusAtom,
  sortSessions,
} from "@/atoms/sessions";
import { fetchSidebar } from "@/rest/im";

/**
 * 单请求加载侧栏三段（频道/私信 + 助手），一次写入两个 atom——三段一起出现，
 * 替代两个独立请求先后到达导致的分段跳出。频道/私信若云端故障由后端降级为空；
 * 总失败（server-agent 不可达）也降级为空并标记 loaded，避免一直卡在骨架。
 */
export const loadSidebarAtom = atom(null, async (_get, set) => {
  try {
    const { conversations, sessions } = await fetchSidebar();
    set(conversationsAtom, sortConversations(conversations));
    set(sessionsAtom, sortSessions(sessions));
    set(sessionsStatusAtom, "loaded");
  } catch {
    // 总失败（server-agent 不可达）：保留已有数据（如 WS 已填充的会话），
    // 仅退出骨架；首次加载时两 atom 本就为空，空段会正确显示空态。
    set(sessionsStatusAtom, "loaded");
  }
});
