"use client";

import { cn } from "@meshbot/design";
import { useTranslations } from "next-intl";
import { forwardRef } from "react";
import { combineAgentAvatar, parseAgentAvatar } from "@/lib/agent-avatar";

/** 头像编辑器可选 emoji（覆盖常见助手人格意象，非穷举，留手输口子兜底）。 */
const AVATAR_EMOJI_OPTIONS = [
  "🤖",
  "🧠",
  "🚀",
  "🛠️",
  "📊",
  "🎨",
  "✨",
  "🦉",
  "🐙",
  "🔍",
  "💡",
  "🌐",
  "📚",
  "⚡",
  "🎯",
  "🧩",
] as const;

/** 头像编辑器预设背景色（8 个，含默认橙 #f97316）。 */
const AVATAR_COLOR_OPTIONS = [
  "#f97316",
  "#3b82f6",
  "#22c55e",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
  "#ef4444",
  "#64748b",
] as const;

interface AgentAvatarFieldProps {
  value?: string;
  onChange?: (value: string) => void;
}

/**
 * 头像编辑：预设 emoji 按钮 + 手输框（覆盖预设外的自定义符号）+ 8 个预设
 * 背景色块，合成 `emoji|#hex` 写回表单字段。`FormItem` 单子节点注入
 * `value`/`onChange`（另含 onBlur/name/ref，本控件不需要，忽略）。
 *
 * 用 `forwardRef` 是为了兼容 `react-hook-form` 的 `field.ref` 注入——本控件
 * 没有单一可聚焦元素能代表整体，转发到外层容器 div 即可（避免 React 19 对
 * 函数组件收 ref 报警告，参考 `model-form-panel.tsx` 的 ProviderSelect）。
 */
export const AgentAvatarField = forwardRef<
  HTMLDivElement,
  AgentAvatarFieldProps
>(({ value, onChange }, ref) => {
  const t = useTranslations("agent.editor");
  const { emoji, color } = parseAgentAvatar(value ?? "");
  const isPreset = (AVATAR_EMOJI_OPTIONS as readonly string[]).includes(emoji);

  const setEmoji = (next: string) =>
    onChange?.(combineAgentAvatar(next, color));
  const setColor = (next: string) =>
    onChange?.(combineAgentAvatar(emoji, next));

  return (
    <div ref={ref} className="flex flex-col gap-3">
      <div
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[22px] leading-none"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      >
        {emoji}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {AVATAR_EMOJI_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setEmoji(option)}
            aria-label={t("avatarEmojiOption", { emoji: option })}
            aria-pressed={option === emoji}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md text-[16px] leading-none transition-colors hover:bg-accent",
              option === emoji && "bg-accent ring-1 ring-ring",
            )}
          >
            {option}
          </button>
        ))}
        <input
          value={isPreset ? "" : emoji}
          onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
          placeholder={t("avatarEmojiCustomPlaceholder")}
          aria-label={t("avatarEmojiCustomLabel")}
          className="h-8 w-14 rounded-md border border-input bg-transparent px-2 text-center text-[14px] placeholder:text-muted-foreground/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {AVATAR_COLOR_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setColor(option)}
            aria-label={t("avatarColorOption", { color: option })}
            aria-pressed={option === color}
            style={{ backgroundColor: option }}
            className={cn(
              "h-6 w-6 shrink-0 rounded-full ring-offset-2 ring-offset-background transition-shadow",
              option === color
                ? "ring-2 ring-foreground"
                : "hover:ring-1 hover:ring-muted-foreground/50",
            )}
          />
        ))}
      </div>
    </div>
  );
});
AgentAvatarField.displayName = "AgentAvatarField";
