/**
 * 会话首屏加载历史时的骨架占位（模仿消息行：头像 + 名字 + 文本）。
 *
 * 从 `apps/web-agent/src/components/im/message-skeleton.tsx` 迁入
 * （Task 7）——组件零外部依赖，整体搬迁；原文件改为 re-export。
 */
export function MessageSkeleton() {
  return (
    <div className="flex w-full flex-1 flex-col gap-4 py-2" aria-hidden>
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex gap-3">
          <div className="mt-0.5 h-7 w-7 shrink-0 animate-pulse rounded-[6px] bg-foreground/10" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2">
              <div className="h-3 w-24 animate-pulse rounded bg-foreground/10" />
              <div className="h-2.5 w-10 animate-pulse rounded bg-foreground/10" />
            </div>
            <div
              className="h-3 animate-pulse rounded bg-foreground/10"
              style={{ width: `${70 - row * 8}%` }}
            />
            {row % 2 === 0 && (
              <div className="h-3 w-2/5 animate-pulse rounded bg-foreground/10" />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
