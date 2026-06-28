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
 * agent 产出产物（`present_file`）后自动打开右侧预览面板：
 * - 进入会话首次加载历史只记 seen、不自动弹（避免一进会话就弹旧产物）；
 * - 之后新出现的 present_file，仅在当前**不在看预览**时弹**第一个**新产物
 *   （多个同时产出只弹第一个；用户正在看某产物时不打扰、不覆盖）。
 */
export function useAutoOpenArtifact(messages: TimelineMessage[]): void {
  const setArtifact = useSetAtom(previewArtifactAtom);
  const setType = useSetAtom(assistantPanelTypeAtom);
  const setOpen = useSetAtom(assistantPanelOpenAtom);
  const panelType = useAtomValue(assistantPanelTypeAtom);
  // 用 ref 镜像 panelType 供 effect 同步读，不进依赖（避免切预览后又触发 effect）。
  const panelTypeRef = useRef(panelType);
  panelTypeRef.current = panelType;
  const seenRef = useRef<Set<string>>(new Set());
  const initRef = useRef(false);

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
    if (!initRef.current) {
      initRef.current = true;
      for (const p of presents) {
        seenRef.current.add(p.id);
      }
      return;
    }
    const fresh = presents.filter((p) => !seenRef.current.has(p.id));
    if (fresh.length === 0) {
      return;
    }
    for (const p of fresh) {
      seenRef.current.add(p.id);
    }
    if (panelTypeRef.current === "preview") {
      return;
    }
    const first = fresh[0];
    setArtifact({ path: first.path, title: first.title });
    setType("preview");
    setOpen(true);
  }, [messages, setArtifact, setType, setOpen]);
}
