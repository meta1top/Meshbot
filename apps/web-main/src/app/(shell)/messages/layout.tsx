"use client";

import type { ReactNode } from "react";
import { ImSidebar } from "@/components/im/im-sidebar";

/**
 * `/messages/*` IM 壳:左侧 Agent-DM 侧栏 + 右会话区,套白底内容卡。
 * 导航由 (shell) 持久壳的 rail 承担;鉴权由根 `Providers` 里的全局 `AuthGuard` 统一负责。
 */
export default function MessagesLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0">
      <ImSidebar />
      <main className="min-w-0 flex-1 overflow-auto rounded-(--shell-radius) bg-(--shell-content)">
        {children}
      </main>
    </div>
  );
}
