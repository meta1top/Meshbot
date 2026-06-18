"use client";

import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { ModelStep } from "@/components/setup/model-step";

/**
 * 已登录但未配置模型时的引导页：用登录后 shell 外壳（rail + 顶栏），
 * sidebar=null 不带频道侧栏，居中卡片。完成后由 AuthGuard 的 model-configs
 * 查询自动检测到有模型并切回正常内容，无需手动 redirect。
 */
export function ModelSetupGate() {
  return (
    <AppShellLayout sidebar={null}>
      <div className="mx-auto w-full max-w-[520px] py-2">
        <ModelStep onDone={() => {}} />
      </div>
    </AppShellLayout>
  );
}
