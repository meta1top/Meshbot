"use client";

import type { ReactNode } from "react";
import { RailNav } from "./rail-nav";

interface RailIconItem {
  key: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}
export interface RailIconStripProps {
  items: RailIconItem[];
  className?: string;
}

/** @deprecated 用 RailNav orientation="horizontal"。薄别名保调用点。 */
export function RailIconStrip({ items, className }: RailIconStripProps) {
  const activeKey = items.find((i) => i.active)?.key;
  return (
    <RailNav
      orientation="horizontal"
      className={className}
      items={items.map(({ key, icon, label }) => ({ key, icon, label }))}
      activeKey={activeKey}
      onSelect={(key) => items.find((i) => i.key === key)?.onClick?.()}
    />
  );
}
