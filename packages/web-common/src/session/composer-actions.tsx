"use client";

import { Blocks, ChevronDown, Link2, Shield } from "lucide-react";

export interface ComposerActionsLabels {
  skills: string;
  apps: string;
  permissions: string;
  /** 悬浮提示（即将上线）。 */
  comingSoon: string;
}

/**
 * Composer 前导动作链：技能 / 连应用 / 权限。三者目前**均为占位**（点击无副作用，
 * title 提示即将上线），作为 {@link ChatInput} 的 `leadingActions` 传入。
 *
 * 放 web-common 是因为它没有任何数据依赖（纯展示 + labels 注入），本地端与云端
 * 的 composer 应当长一样——云端此前不注入 leadingActions，动作栏左侧是空的。
 */
export function ComposerActions({ labels }: { labels: ComposerActionsLabels }) {
  const items = [
    {
      key: "skills",
      icon: <Blocks className="h-3.5 w-3.5" />,
      label: labels.skills,
    },
    {
      key: "apps",
      icon: <Link2 className="h-3.5 w-3.5" />,
      label: labels.apps,
    },
    {
      key: "permissions",
      icon: <Shield className="h-3.5 w-3.5" />,
      label: labels.permissions,
    },
  ];
  return (
    <>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          title={labels.comingSoon}
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {it.icon}
          {it.label}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      ))}
    </>
  );
}
