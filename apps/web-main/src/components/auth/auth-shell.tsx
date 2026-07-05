"use client";

import { cn } from "@meshbot/design";
import { BrandLogo, PreLoginShellView } from "@meshbot/web-common/shell";

interface AuthShellProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * 云端登录前壳：对话式居中单列 + 顶部品牌，套统一暖炭·配橙视觉语言。
 *
 * 复用 `@meshbot/web-common/shell` 与 web-agent 共用的 `PreLoginShellView`，
 * 品牌头（`BrandLogo`）挂在内容列顶部，所有子页（登录/注册/授权）共享。
 */
export function AuthShell({ children, className }: AuthShellProps) {
  return (
    <PreLoginShellView className={cn("max-w-[380px]", className)}>
      <BrandLogo size="md" withWordmark />
      <div className="w-full text-left">{children}</div>
    </PreLoginShellView>
  );
}
