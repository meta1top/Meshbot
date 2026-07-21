/**
 * 会话时间线的统一视图模型（`useSessionStream` 唯一输出形态）。
 *
 * 从 `apps/web-agent/src/components/session/message-list.tsx` 迁入——该文件
 * 原是类型的唯一定义处，web-agent 侧现改为从本模块 re-export，保持既有
 * `import type { TimelineMessage } from "@/components/session/message-list"`
 * 调用方零改动。
 */

/** 时间线消息里的一条工具调用视图（流式/终态混合展示）。 */
export interface ToolCallView {
  toolCallId: string;
  name: string;
  /** 权威参数（run.tool_call_start 后填；历史读取也填）。流式阶段为 undefined。 */
  args?: unknown;
  /**
   * 流式累积的原始 args JSON（status==="streaming" 时打字预览用）。
   * run.tool_call_start 到达升级为 running 时清空（已有权威 args）。
   */
  argsText?: string;
  /** 流式累积的 stdout/stderr（仅 bash 等流式 tool）。 */
  progress?: string;
  /** 最终结果（end 后；历史读取也填这里）。 */
  result?: string;
  /** dispatch_subagent 专用：已认领的子会话 id（spawned 事件 / history 附带）。 */
  subSessionId?: string;
  /** streaming = LLM 仍在流式生成本工具的参数（尚未开始执行）。 */
  status: "streaming" | "running" | "ok" | "error";
  /**
   * HITL 关卡已被应答的来源（Task 17，`run.hitl_settled` 广播帧写入）：非空
   * 即该 confirm/ask 卡片已终局，即便 `status` 仍是 `"running"`——真正的工具
   * 执行结果（`run.tool_call_end`）可能因实际副作用（发消息等）而晚到。卡片
   * 据此立即禁用交互，避免用户对着一张早已失效的确认卡反复点击，或把自己
   * 被丢弃的决定误当成已生效（Agent 级观察通道 D3 先到先得仲裁）。
   */
  hitlSettledBy?: "local" | "remote" | "observer";
}

/** 时间线上的一条消息（统一视图模型）。 */
export interface TimelineMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 待处理用户消息（仅 user）：服务端尚未开始调 LLM；渲染在输入框上方 pending 区。 */
  pending?: boolean;
  /** 流式输出中（仅 assistant）：尾部追加闪烁光标。 */
  streaming?: boolean;
  /**
   * 等待首个 chunk 的 assistant 占位（仅 assistant）：
   * 已发出用户消息但 LLM 还没返回任何 token。渲染为转圈。
   */
  loading?: boolean;
  failed?: boolean;
  /** run 失败的错误原因（仅实时 run.error 事件携带；历史恢复的 failed 行无此值）。 */
  errorText?: string;
  /**
   * 结构化错误原因（透传自 `RunErrorEvent.reason`）。目前仅 L3 远程二次门控
   * 拒绝场景设置为 `"agent_not_remotable"`：渲染层据此走专属 next-intl 文案，
   * 而不是展示 `errorText` 的原始兜底文本。未设置时按既有行为展示 `errorText`。
   */
  errorReason?: string;
  /** 推理模型的思考过程（仅 assistant）：流式累积，渲染在气泡上方可展开折叠区。 */
  reasoning?: string;
  /**
   * 推理开始时间（毫秒时间戳，仅 assistant）。reasoning 正在流入时显示
   * 「思考中 Xs」；assistant content 开始时切换为「已思考 Xs」固定值。
   */
  reasoningStartedAt?: number;
  /** 推理结束耗时（毫秒，仅 assistant）。设值后认为推理已结束。 */
  reasoningDurationMs?: number;
  toolCalls?: ToolCallView[];
  /**
   * 结构化元数据（来自 session_message.metadata JSON 列）。
   * 压缩占位行携带 kind="compaction"；其余消息为 null / undefined。
   */
  metadata?: {
    kind: string;
    removedCount?: number;
    [key: string]: unknown;
  } | null;
  /** assistant 反馈态（来自 history）：up=点赞 down=不喜欢 null=未评价。 */
  feedback?: "up" | "down" | null;
}
