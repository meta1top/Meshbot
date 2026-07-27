"use client";

import { useEffect, useState } from "react";
import { isReasoningThinking } from "./reasoning-thinking";
import type { TimelineMessage } from "./timeline";

/**
 * 消息流末尾常驻状态行的阶段。`null` = 不渲染（既没有 run 在跑，也没有
 * 会话压缩在进行——见 {@link deriveStatusLinePhase}）。
 */
export type StatusLinePhase =
  | "thinking"
  | "executing"
  | "streaming"
  | "compacting"
  | null;

/**
 * 每个阶段的文案变体（至少 1 项）。数组下标 0 是该阶段出现的首条文案；
 * 长度 > 1 时组件内部纯前端 `setInterval` 轻量轮换（~3s 一次），避免长时间
 * 停留在同一阶段时文案显得呆板——轮换不依赖任何后端信号，仅装饰用途，
 * `prefers-reduced-motion: reduce` 时停止轮换（停在首条文案）。
 */
export interface StatusLineLabels {
  thinking: readonly string[];
  executing: readonly string[];
  streaming: readonly string[];
  compacting: readonly string[];
}

export interface StatusLineProps {
  /** 当前阶段；`null` 时组件不渲染任何 DOM。 */
  phase: StatusLinePhase;
  labels: StatusLineLabels;
  /** 轮换间隔（毫秒）。默认 3000，测试可注入更短的值。 */
  rotateIntervalMs?: number;
}

const DEFAULT_ROTATE_INTERVAL_MS = 3000;

/**
 * 消息流末尾常驻状态行：run 进行期间（含压缩中）在列表末尾恒渲染一行，
 * 三点动画 + 按阶段区分的文案。
 *
 * 取代原先绑在 assistant 占位消息上的 `TypingDots`——那种实现是 timeline
 * 里一条 `loading-${id}` 假 assistant 消息，只在「等首个 token」这一小段
 * 可见；本组件纯展示、不进 timeline 数组，`running || compacting` 为真的
 * 整个区间都渲染（见 `deriveStatusLinePhase`），阶段变化时文案跟着换。
 *
 * 与 assistant 正文自身的 `streaming` 光标不是同一层：那是气泡内文字尾部
 * 的光标，描述「这条消息内容如何呈现」；本组件是列表末尾独立一行，描述
 * 「整个 run 当前处于什么阶段」。`streaming` 阶段下两者会同时出现（光标在
 * 气泡里、状态行在列表最下面）——这是 spec 明确要的效果（对齐 Claude Code：
 * 正文流式产出的同时，下方仍有一行阶段提示「处理中…」），不是两个进行中
 * 指示器重复表达同一件事。
 */
export function StatusLine({
  phase,
  labels,
  rotateIntervalMs = DEFAULT_ROTATE_INTERVAL_MS,
}: StatusLineProps) {
  const variants = phase ? labels[phase] : undefined;
  const [variantIndex, setVariantIndex] = useState(0);

  // 阶段切换：轮换下标归零，新阶段从它自己的首条文案重新开始。
  // biome-ignore lint/correctness/useExhaustiveDependencies: phase 只作触发依据（effect 体内恒重置为 0，不读取其值），故意不在 body 里引用
  useEffect(() => {
    setVariantIndex(0);
  }, [phase]);

  useEffect(() => {
    if (!variants || variants.length <= 1) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return; // 无障碍：减少动态效果时不轮换，停在首条文案
    }
    const id = setInterval(() => {
      setVariantIndex((i) => (i + 1) % variants.length);
    }, rotateIntervalMs);
    return () => clearInterval(id);
  }, [variants, rotateIntervalMs]);

  if (!phase || !variants || variants.length === 0) return null;
  const text = variants[variantIndex % variants.length];

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
    >
      <ThreeDots />
      <span>{text}</span>
    </div>
  );
}

/** "..." 三点跳动指示器，视觉从原 message-list.tsx 的 TypingDots 迁移而来。 */
function ThreeDots() {
  return (
    <span aria-hidden className="inline-flex items-center gap-1 align-middle">
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:-0.3s]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:-0.15s]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/40" />
    </span>
  );
}

/**
 * 从 run/compaction 信号派生 {@link StatusLinePhase}（spec §三）。
 *
 * 优先级（从高到低）：
 * 1. `compacting` 为真 → `"compacting"`
 * 2. 最后一条消息是 assistant 且有工具卡处于 `running` → `"executing"`
 * 3. 最后一条 assistant 消息 reasoning 仍在思考中（{@link isReasoningThinking}）→ `"thinking"`
 * 4. 最后一条 assistant 消息正文流式产出中（`streaming===true`）→ `"streaming"`
 * 5. 兜底（`running` 为真但以上都不命中，如 run 刚起、尚无任何信号；或最后
 *    一条消息是 user——已发出但 assistant 还没来得及建任何占位）→ `"thinking"`
 *
 * `running` 与 `compacting` 均为假时返回 `null`（不渲染）。
 */
export function deriveStatusLinePhase(params: {
  running: boolean;
  /** 压缩原因字符串（真值）或 null/undefined（未压缩）——与 `SessionStream.compacting` 同型，这里只关心真假。 */
  compacting: string | null | undefined;
  /** 已落定的时间线消息（不含 pending 区），取最后一条判定信号。 */
  messages: readonly TimelineMessage[];
}): StatusLinePhase {
  const { running, compacting, messages } = params;
  if (compacting) return "compacting";
  if (!running) return null;
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    if (last.toolCalls?.some((t) => t.status === "running")) {
      return "executing";
    }
    // isReasoningThinking 的 streaming 兜底参数只在「已有 reasoning 文本」时才有意义
    // （见该函数文档：刷新落在 reasoning 流式中的场景）。这里必须先判 `last.reasoning`
    // truthy，否则一条纯正文流式消息（无 reasoning）会被误判成 thinking——它的
    // `streaming===true` 会被 isReasoningThinking 当成"思考仍在流"的信号。
    if (
      last.reasoning &&
      isReasoningThinking({
        startedAt: last.reasoningStartedAt,
        durationMs: last.reasoningDurationMs,
        streaming: last.streaming,
      })
    ) {
      return "thinking";
    }
    if (last.streaming) return "streaming";
  }
  return "thinking";
}
