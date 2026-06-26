/**
 * 市场技能列表加载骨架：模仿 MarketSkillCard 的卡片结构（标题 + 描述两行 +
 * 作者/版本/下载量 meta 行 + 右侧安装按钮），脉冲动画占位，撑住布局避免跳动。
 */
export function MarketSkillCardSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="rounded-md border border-border bg-card p-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3.5 w-32 animate-pulse rounded bg-foreground/10" />
              <div
                className="h-3 animate-pulse rounded bg-foreground/10"
                style={{ width: `${78 - row * 6}%` }}
              />
              <div className="h-3 w-2/5 animate-pulse rounded bg-foreground/10" />
              <div className="flex items-center gap-2 pt-0.5">
                <div className="h-2.5 w-16 animate-pulse rounded bg-foreground/10" />
                <div className="h-2.5 w-8 animate-pulse rounded bg-foreground/10" />
                <div className="h-2.5 w-12 animate-pulse rounded bg-foreground/10" />
              </div>
            </div>
            <div className="h-6 w-12 shrink-0 animate-pulse rounded bg-foreground/10" />
          </div>
        </div>
      ))}
    </div>
  );
}
