"use client";

import { Coffee, Palette, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { ChatInput, type ChatInputLabels } from "./chat-input";

export interface SessionLauncherLabels {
  /** 品牌字标（大标题第一行），如 "MeshBot"。 */
  brand: string;
  /** 标语（大标题第二行）。 */
  slogan: string;
  /** 场景分段（视觉占位，不接功能）。 */
  scenes: { daily: string; code: string; design: string };
  /** 输入框占位符。 */
  placeholder: string;
  /** ChatInput 自身的 labels。 */
  chatInput: ChatInputLabels;
}

export interface SessionLauncherProps {
  draft: string;
  onDraftChange: (next: string) => void;
  onSend: (text: string) => void;
  sending?: boolean;
  labels: SessionLauncherLabels;
  /**
   * 建议 chips 数据：`null` = 加载中（显示骨架）；`[]` = 隐藏；有值则渲染。
   * 数据来源由调用方决定（web-agent 拉后端建议，web-main 用默认列表）。
   */
  suggestions?: string[] | null;
  /** 点击建议 chip：把文本填入草稿（不自动发送）。 */
  onPickSuggestion?: (text: string) => void;
  /** 动作栏左侧前导动作（web-agent 的技能/连应用/权限；远程模式不传 = 隐藏）。 */
  leadingActions?: ReactNode;
  /** 动作栏右侧选择器（模型选择）。 */
  trailingActions?: ReactNode;
  /** composer 面板内、输入框下方的目标选择条（web-agent：本地/工作区；web-main：设备）。 */
  targetBar?: ReactNode;
}

/**
 * 会话起手台（两端共用）：品牌大标题 + 场景分段 + 建议 chips + 暖色 composer
 * 面板（ChatInput + 目标选择条）。发送即建会话——建会话的实现由调用方注入
 * （web-agent 本地 createSession / 远程 run 隧道；web-main 走草稿交接 + 远程 create）。
 *
 * 纯展示 + 插槽：数据与动作全部 props 注入，不含 jotai / next-intl / app 路径。
 */
export function SessionLauncher({
  draft,
  onDraftChange,
  onSend,
  sending,
  labels,
  suggestions,
  onPickSuggestion,
  leadingActions,
  trailingActions,
  targetBar,
}: SessionLauncherProps) {
  // 场景分段（视觉占位，本地 state 切高亮，不接功能）
  const [scene, setScene] = useState("daily");
  const scenes = [
    { key: "daily", label: labels.scenes.daily, icon: Coffee },
    { key: "code", label: labels.scenes.code, icon: Terminal },
    { key: "design", label: labels.scenes.design, icon: Palette },
  ];

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="flex w-full max-w-[600px] flex-col items-start gap-5">
        <div>
          <h1 className="text-[40px] font-extrabold leading-[1.08] tracking-tight text-foreground">
            {labels.brand}
            <br />
            {labels.slogan}
          </h1>
        </div>

        {/* 场景分段（视觉占位） */}
        <div className="inline-flex gap-1 rounded-xl bg-(--shell-sidebar) p-1">
          {scenes.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setScene(s.key)}
              className={
                scene === s.key
                  ? "flex items-center gap-1.5 rounded-lg bg-(--shell-chrome) px-4 py-1.5 text-[13px] font-semibold text-white"
                  : "flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-[13px] font-semibold text-(--shell-sidebar-fg)/60 hover:text-(--shell-sidebar-fg)"
              }
            >
              <s.icon className="h-3.5 w-3.5" />
              {s.label}
            </button>
          ))}
        </div>

        {/* 建议 chips：点击填入草稿 */}
        <SuggestionChipsView
          items={suggestions}
          onPick={(text) => onPickSuggestion?.(text)}
        />

        {/* composer：暖色圆角底板包裹 ChatInput（动作栏内含前导动作 + 模型 +
            上传 + 发送）+ 下方目标选择器行 */}
        <div className="w-full rounded-2xl bg-(--shell-sidebar) p-2.5">
          <ChatInput
            value={draft}
            onChange={onDraftChange}
            onSend={onSend}
            isLoading={sending}
            placeholder={labels.placeholder}
            leadingActions={leadingActions}
            trailingActions={trailingActions}
            labels={labels.chatInput}
          />
          {targetBar}
        </div>
      </div>
    </div>
  );
}

/** 建议胶囊（纯展示）：null = 骨架；[] = 隐藏。 */
function SuggestionChipsView({
  items,
  onPick,
}: {
  items?: string[] | null;
  onPick: (text: string) => void;
}) {
  if (items === undefined) return null;
  if (items === null) {
    return (
      <div className="mb-2 flex flex-wrap gap-2">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-8 w-28 animate-pulse rounded-lg bg-muted"
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
          className="rounded-lg border border-border bg-card px-3.5 py-2 text-[13px] font-medium text-foreground/85 transition-colors hover:border-(--shell-accent) hover:text-(--shell-accent)"
        >
          {s}
        </button>
      ))}
    </div>
  );
}
