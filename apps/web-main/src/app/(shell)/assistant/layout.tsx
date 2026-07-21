import type { ReactNode } from "react";
import { Suspense } from "react";
import { AssistantSidebar } from "@/components/assistant/assistant-sidebar";

/**
 * 助手段持久 layout：设备→会话展开树侧栏渲染一次，`/assistant` ↔
 * `/assistant/[agentId]` 间导航不 remount——展开态与已加载会话得以保留
 * （对齐 web-agent 的持久侧栏体验）。各页只负责主区内容。
 * `AssistantSidebar` 用 `useSearchParams`，须 Suspense 包裹。
 */
export default function AssistantLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <AssistantSidebar />
      </Suspense>
      {children}
    </>
  );
}
