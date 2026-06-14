"use client";

export function PlaceholderSidebar({ title }: { title: string }) {
  return (
    <div className="flex h-full flex-col bg-[var(--shell-sidebar)] px-2 py-2.5 text-white">
      <div className="border-b border-white/15 px-1.5 pb-2.5 text-[15px] font-extrabold">
        {title}
      </div>
    </div>
  );
}
