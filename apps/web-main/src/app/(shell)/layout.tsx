import type { ReactNode } from "react";
import { WorkspaceRail } from "@/components/shell/workspace-rail";

/** (shell) 段持久壳:深 rail + 内容区。切区不 remount rail。鉴权由根 Providers 的 AuthGuard 负责。 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-(--shell-chrome) text-foreground">
      <WorkspaceRail />
      <div className="min-h-0 flex-1 overflow-hidden pr-1.5 pb-1.5 pt-1.5">
        {children}
      </div>
    </div>
  );
}
