"use client";

import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

export interface PreLoginShellViewProps {
  /** 顶部整宽条（web-agent 注入拖拽栏 + 切换；web-main 可留空或注入语言切换）。 */
  topBar?: ReactNode;
  /** 居中单列内容（品牌 + 标题 + 表单/按钮 + 脚注）。 */
  children: ReactNode;
  /** 覆盖内容列默认 class（宽度/间距/对齐）。 */
  className?: string;
}

/**
 * 登录前对话式壳（纯展示）：暖底整屏 + 顶部可选整宽条 + 居中单列内容。
 * 两端共用：各 app 薄容器注入自己的 topBar（拖拽栏/切换）与内容。
 */
export function PreLoginShellView({
  topBar,
  children,
  className,
}: PreLoginShellViewProps) {
  return (
    <div className="relative flex min-h-screen flex-col bg-(--surface-0) text-(--shell-sidebar-fg)">
      {topBar}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
        <div
          className={cn(
            "flex w-full max-w-[360px] flex-col items-center gap-5 text-center",
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
