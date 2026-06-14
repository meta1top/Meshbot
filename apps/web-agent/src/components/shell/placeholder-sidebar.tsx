"use client";

export function PlaceholderSidebar({ title }: { title: string }) {
  return (
    <div className="flex h-full flex-col bg-(--shell-sidebar) text-white">
      <div className="flex h-11 shrink-0 items-center border-b border-white/15 px-3.5 text-[15px] font-extrabold">
        {title}
      </div>
    </div>
  );
}
