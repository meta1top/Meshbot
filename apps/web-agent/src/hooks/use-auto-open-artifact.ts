"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import {
  assistantPanelOpenAtom,
  assistantPanelTypeAtom,
  previewArtifactAtom,
} from "@/atoms/assistant-panel";
import type { TimelineMessage } from "@/components/session/message-list";

/**
 * agent 实时产出产物（`present_file`）后自动打开右侧预览面板：
 * - 仅在 **running（WebSocket 实时流式输出）** 期间新出现的 present_file 才弹；
 * - 历史加载 / 切换会话（running=false）只记 seen、不自动弹（历史查看不打扰）；
 * - 同时只弹**第一个**新产物；用户正在看预览时不打扰、不覆盖。
 *
 * seen 累积跨会话无妨：toolCallId 全局唯一，历史产物一旦记入 seen 就不会再弹。
 */
export function useAutoOpenArtifact(
  messages: TimelineMessage[],
  running: boolean,
): void {
  const setArtifact = useSetAtom(previewArtifactAtom);
  const setType = useSetAtom(assistantPanelTypeAtom);
  const setOpen = useSetAtom(assistantPanelOpenAtom);
  const panelType = useAtomValue(assistantPanelTypeAtom);
  // 用 ref 镜像 panelType 供 effect 同步读，不进依赖（避免切预览后又触发 effect）。
  const panelTypeRef = useRef(panelType);
  panelTypeRef.current = panelType;
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const presents: { id: string; path: string; title?: string }[] = [];
    for (const m of messages) {
      for (const tc of m.toolCalls ?? []) {
        if (tc.name !== "present_file" || tc.status === "streaming") {
          continue;
        }
        const args = (tc.args ?? {}) as { path?: string; title?: string };
        if (args.path) {
          presents.push({
            id: tc.toolCallId,
            path: args.path,
            title: args.title,
          });
        }
      }
    }
    // 先全部记 seen（无论弹不弹），保证历史/切会话产物不会在后续 running 时被误弹。
    const fresh = presents.filter((p) => !seenRef.current.has(p.id));
    for (const p of fresh) {
      seenRef.current.add(p.id);
    }
    // 仅实时流式期间弹；历史加载 / 切会话（running=false）只记 seen、不弹。
    if (!running || fresh.length === 0) {
      return;
    }
    // 用户正在看某个预览时不打扰、不覆盖。
    if (panelTypeRef.current === "preview") {
      return;
    }
    const first = fresh[0];
    setArtifact({ path: first.path, title: first.title });
    setType("preview");
    setOpen(true);
  }, [messages, running, setArtifact, setType, setOpen]);
}
