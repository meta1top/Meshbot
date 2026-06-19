/**
 * 侧栏加载骨架：频道/私信/助手三段的占位行（脉冲动画）。配合 /api/sidebar
 * 单请求加载——加载期间撑住布局、给出反馈，数据到了一次性替换，不再分段跳出。
 */
export function SidebarSkeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-hidden>
      {[0, 1, 2].map((section) => (
        <div key={section} className="space-y-1.5">
          <div className="mx-2 h-3 w-12 rounded bg-white/10" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-2 px-2 py-1">
              <div className="h-3.5 w-3.5 shrink-0 rounded bg-white/10" />
              <div
                className="h-3 rounded bg-white/10"
                style={{ width: `${64 - row * 12}%` }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
