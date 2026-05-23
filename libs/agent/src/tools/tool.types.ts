import type { EventEmitter2 } from "@nestjs/event-emitter";
import type { z } from "zod";

/** Tool 实现接口。装饰器仅作 metadata 标记；真正的契约在此。 */
export interface MeshbotTool<TArgs = unknown, TResult = unknown> {
  /** 唯一名字（暴露给 LLM）。 */
  readonly name: string;
  /** 描述，传给 LLM 作为 tool description。 */
  readonly description: string;
  /** Zod schema 校验 LLM 给的 args，同时生成 JSON Schema 给 LLM。 */
  readonly schema: z.ZodType<TArgs>;
  /** 执行。result 序列化为 string 后作为 ToolMessage.content 给 LLM。 */
  execute(args: TArgs, ctx: ToolContext): Promise<TResult>;
}

/** 每次 tool 调用注入的上下文。 */
export interface ToolContext {
  sessionId: string;
  /** 当前 assistant messageId（ReAct 一轮内可能多个 tool call，共享同一 messageId）。 */
  messageId: string;
  /** LangChain 给的 tool_call_id（绑定到该次具体调用）。 */
  toolCallId: string;
  /** Tool 实现用此 emit run.tool_call_progress 等事件。 */
  emitter: EventEmitter2;
  /** 复用 run 的 AbortSignal；用户 Stop 时 tool 也中断。 */
  signal: AbortSignal;
}
