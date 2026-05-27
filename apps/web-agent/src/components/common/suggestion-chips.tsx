"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { fetchSuggestions } from "@/rest/stats";

interface SuggestionChipsProps {
  /** 点击胶囊：把文本填入输入框（不自动发送）。 */
  onPick: (text: string) => void;
}

/**
 * 输入框上方的"下一步行动建议"胶囊。
 * - 挂载后自取建议；loading 显示骨架。
 * - 后端返回空（无会话）→ 用 i18n 默认建议兜底。
 * - 请求失败 → 静默隐藏，不阻塞输入。
 */
export function SuggestionChips({ onPick }: SuggestionChipsProps) {
  const t = useTranslations("home");
  // null = loading；[] = 隐藏
  const [items, setItems] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchSuggestions()
      .then((res) => {
        if (!alive) return;
        const list =
          res.suggestions.length > 0
            ? res.suggestions
            : (t.raw("defaultSuggestions") as string[]);
        setItems(list);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [t]);

  if (items === null) {
    return (
      <div className="mb-2 flex flex-wrap gap-2">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-7 w-28 animate-pulse rounded-full bg-accent/30"
          />
        ))}
      </div>
    );
  }
  if (items.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {items.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="rounded-full bg-accent px-3 py-1 text-[13px] text-foreground transition-colors hover:bg-accent/80"
        >
          {s}
        </button>
      ))}
    </div>
  );
}
