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
 * HITL（human-in-the-loop）关卡型工具名——这些工具的卡片会挂起 run 等用户
 * 应答（确认/取消/回答）。与 tool-call-block.tsx 里走特化确认/提问卡的工具集
 * 对齐（present_file/todo_write 是纯展示、不挂起，不在此列）。挂起等人期间
 * 末尾状态行应隐藏，见 {@link deriveStatusLinePhase}。
 */
const HITL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "im_send_message",
  "ask_question",
  "drive_share",
  "drive_create_share",
  "mcp_install",
]);

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
    // 与消息行同构缩进：px-2 + gap-3 + 头像列宽 w-7 占位，让文案左缘对齐正文
    // （而非贴墙）；否则三点紧贴左墙、与带头像的消息不成一列。
    <div role="status" aria-live="polite" className="flex gap-3 px-2 py-1.5">
      <div className="w-7 shrink-0" aria-hidden />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <BreathingLogo />
        <span>{text}</span>
      </div>
    </div>
  );
}

/**
 * 橙色品牌 logo「呼吸节奏」转动指示器（取代原三点跳动 TypingDots）。
 * 动画是 globals.css 的 `.mb-breathe-spin`（rotate + scale/opacity 脉冲，
 * ease-in-out 非线性），刻意不用死板的 linear 自旋。logo.svg 本身即焦橙
 * (#fa771c)，无需滤色；两端 app（web-agent / web-main）都在 web 根伺服
 * `/logo.svg`。`alt=""` + `aria-hidden`：纯装饰，语义由外层 role="status" 承载。
 */
function BreathingLogo() {
  return (
    <img
      src="/logo.svg"
      alt=""
      aria-hidden
      width={16}
      height={16}
      className="mb-breathe-spin h-4 w-4 shrink-0"
    />
  );
}

/**
 * 从 run/compaction 信号派生 {@link StatusLinePhase}（spec §三）。
 *
 * 优先级（从高到低）：
 * 1. `compacting` 为真 → `"compacting"`
 * 2. 最后一条 assistant 消息有 HITL 关卡卡片正挂起等用户应答 → `null`（不渲染）
 * 3. 最后一条消息是 assistant 且有工具卡处于 `running` → `"executing"`
 * 4. 最后一条 assistant 消息 reasoning 仍在思考中（{@link isReasoningThinking}）→ `"thinking"`
 * 5. 最后一条 assistant 消息正文流式产出中（`streaming===true`）→ `"streaming"`
 * 6. 兜底（`running` 为真但以上都不命中，如 run 刚起、尚无任何信号；或最后
 *    一条消息是 user——已发出但 assistant 还没来得及建任何占位）→ `"thinking"`
 *
 * 第 2 条（HITL 挂起）：`im_send_message` / `ask_question` / `drive_*` /
 * `mcp_install` 的确认/提问卡挂起 run 等用户点确认或作答时，run 是「挂起等人」
 * 而非「Agent 在干活」——此刻末尾若还顶一行"思考中/正在执行"会误导用户以为
 * Agent 仍在跑（该卡 `status==="running"` 本会命中第 3 条判成 executing）。判据是
 * 卡片仍在等人：`status==="running"` 且尚未 settled（`!hitlSettledBy`，见
 * ToolCallView 该字段 JSDoc）。用户应答后 `hitlSettledBy` 置位或卡片进终态
 * （ok/error），run 恢复执行，状态行照常回到 executing/thinking。
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
    // HITL 关卡挂起（等用户确认/作答）→ 不渲染。必须先于下方 running→executing
    // 判定，否则挂起中的确认卡（status==="running"）会被误判成"正在执行"。
    if (
      last.toolCalls?.some(
        (t) =>
          HITL_TOOL_NAMES.has(t.name) &&
          t.status === "running" &&
          !t.hitlSettledBy,
      )
    ) {
      return null;
    }
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
