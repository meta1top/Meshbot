"use client";

export function PlaceholderSidebar({ title }: { title: string }) {
  return (
    <div className="flex h-full flex-col bg-(--shell-sidebar) px-2 py-2.5 text-white">
      <div className="flex h-9 items-center border-b border-white/15 px-1.5 text-[15px] font-extrabold">
        {title}
      </div>
    </div>
  );
}
