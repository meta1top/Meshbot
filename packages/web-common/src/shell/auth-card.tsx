import { cn } from "@meshbot/design";
import type { ReactNode } from "react";

/** auth 流程统一卡片：白底大圆角 + 双层阴影（近锐远柔）+ 内容淡入动效。 */
export function AuthCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "w-full rounded-2xl border border-foreground/[0.06] bg-background p-6 text-left",
        "shadow-[0_1px_2px_rgba(43,39,35,0.04),0_12px_32px_-12px_rgba(43,39,35,0.12)]",
        "animate-in fade-in slide-in-from-bottom-1 duration-200",
        className,
      )}
    >
      {children}
    </div>
  );
}
