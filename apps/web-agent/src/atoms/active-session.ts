"use client";

import { atom } from "jotai";

/** 主内容区当前展示的会话标识：本机 remoteAgentId 为 null，远程时是云端 Agent id。 */
export interface ActiveAssistantSession {
  id: string;
  remoteAgentId: string | null;
}

/**
 * `/assistant` 页当前展示的会话（由该页路由参数驱动，见 page.tsx 里的同步
 * effect）。未打开任何会话（起手台空态）时为 null。
 *
 * 存在的唯一目的：全局事件总线 `use-global-events.ts` 挂在 shell layout，
 * 常驻但够不到 `/assistant` 页面自己的路由参数，只能靠这个跨组件 atom 知道
 * 「用户正盯着看哪个会话」，从而判断刚到达的 `session.deleted` 事件是否命中
 * 当前打开的会话——命中则说明这条会话被（本机的）另一台设备删了，但用户
 * 还开着它（真机验收缺陷：侧栏行消失了，主内容区却还在显示已删除的对话）。
 */
export const activeAssistantSessionAtom = atom<ActiveAssistantSession | null>(
  null,
);
