"use client";

import { type ReactNode, useState } from "react";
import { OnboardingGate } from "@/components/auth/onboarding-gate";
import { SidebarSlotContext } from "@/components/shell/sidebar-slot-context";
import { WorkspaceSidebar } from "@/components/shell/workspace-sidebar";

/** (shell) 段持久壳:浅色宽侧栏 + 内容区。鉴权由根 Providers 的 AuthGuard 负责；
 *  组织/模型前置引导由 OnboardingGate 负责（缺失时就地引导，满足才渲染 app）。
 *  slot state 承载二级子栏 portal 插槽，故本层需为 client 组件。 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  return (
    <main className="flex h-screen flex-col bg-(--shell-content) text-foreground">
      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar sublistSlotRef={setSlotEl} />
        <div className="relative flex min-h-0 flex-1 overflow-hidden bg-(--shell-content)">
          <SidebarSlotContext.Provider value={slotEl}>
            <OnboardingGate>{children}</OnboardingGate>
          </SidebarSlotContext.Provider>
        </div>
      </div>
    </main>
  );
}
