"use client";

import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { previewArtifactAtom } from "@/atoms/assistant-panel";
import type { TimelineMessage } from "@/components/session/message-list";

/**
 * agent 实时产出产物（`present_file`）后自动打开右侧预览面板：
 * - 仅在 **running（WebSocket 实时流式输出）** 期间新出现的 present_file 才弹；
 * - 历史加载 / 切换会话（running=false）只记 seen、不自动弹（历史查看不打扰）；
 * - 同时只弹**第一个**新产物；同一产物（toolCallId 唯一）不会重复弹出。
 *
 * seen 累积跨会话无妨：toolCallId 全局唯一，历史产物一旦记入 seen 就不会再弹。
 *
 * `agentId`（Task 12）：自动弹出的产物走本机 `path` 源，须带上该会话的
 * agentId 才能拼出正确的 workspace 相对 URL（见 `PreviewArtifact.agentId`
 * 注释），否则多 Agent 下非默认 Agent 的产物会 404。
 *
 * `remote`（真机验收缺陷 3）：远程会话必须传入该会话的对端设备描述符。原实现
 * 漏传 `remote`，`setArtifact` 恒走 `{path, agentId}` 本机分支——产物预览请求
 * 打在本机自己的 server-agent 上，本机 workspace 没有对端产出的文件，404 后被
 * `artifact-body.tsx` 归一成「产物已不存在或已变更」，把排查方向带偏到远端
 * 白名单上。这条自动弹出路径此前一直没被走到（`running` 在远程会话上恒为
 * false，直到 T18/T19 观察通道接上才第一次点亮），是条真实存在但从未暴露过
 * 的死代码。与 `assistant-conversation-body.tsx` 的 `onPreviewArtifact`
 * （`agentId: target.remote ? undefined : sessionAgentId`）保持同一份
 * 「remote 优先、二选一互斥」语义，不重复发明。
 */
export function useAutoOpenArtifact(
  messages: TimelineMessage[],
  running: boolean,
  agentId?: string,
  remote?: { deviceId: string; sessionId: string } | null,
): void {
  const setArtifact = useSetAtom(previewArtifactAtom);
  // 同一产物（toolCallId）只弹一次的去重集合，与 assistantPanelTypeAtom 无关。
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
    const first = fresh[0];
    setArtifact(
      remote
        ? { path: first.path, title: first.title, remote }
        : { path: first.path, title: first.title, agentId },
    );
  }, [messages, running, setArtifact, agentId, remote]);
}
