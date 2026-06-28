"use client";

import { DragRegion } from "@/components/drag-region";
import { ModelStep } from "@/components/setup/model-step";
import { ShellTopBar } from "@/components/shell/shell-top-bar";
import { WorkspaceRail } from "@/components/shell/workspace-rail";

/**
 * 已登录但未配置模型时的引导页：登录后 shell 外壳（rail + 顶栏），居中卡片，
 * 不带频道侧栏与随手问 dock（AuthGuard 在 root 级条件渲染，拿不到 (shell)/layout，
 * 故自拼轻量壳）。完成后由 AuthGuard 的 model-configs 查询自动检测到有模型并切回
 * 正常内容，无需手动 redirect。
 */
export function ModelSetupGate() {
  return (
    <main className="titlebar-safe flex h-screen flex-col bg-(--shell-chrome) text-foreground">
      <DragRegion />
      <ShellTopBar />
      <div className="flex min-h-0 flex-1">
        <WorkspaceRail />
        <div className="relative flex min-h-0 flex-1 overflow-hidden pr-1.5 pb-1.5">
          <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-(--shell-radius) bg-(--shell-content)">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="flex w-full flex-1 flex-col p-4 lg:px-6">
                <div className="mx-auto w-full max-w-[520px] py-2">
                  <ModelStep onDone={() => {}} />
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
