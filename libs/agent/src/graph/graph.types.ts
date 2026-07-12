export interface AgentConfig {
  model: string;
  temperature?: number;
  systemPrompt?: string;
  tools?: string[];
}

export type ThreadId = string;

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /**
   * 推理模型（DeepSeek 等）的思考过程，来源于 AIMessage.additional_kwargs.reasoning_content。
   * checkpointer 一直会持久化它，刷新会话也能拿回；非推理模型为 undefined。
   */
  reasoning?: string;
}

/**
 * 流式 run 产出的事件：
 * - human：本批次每条 user 消息以 HumanMessage 形式写入 checkpointer 时各 yield 一次；
 * - reasoning：单个 reasoning token（DeepSeek 等推理模型先吐 reasoning 再吐 content）；
 * - chunk：单个 assistant content token；
 * - reasoning_done：本轮 LLM 第一次出现非空 tool_calls 字段（reasoning_content 阶段
 *   结束、转入 tool_calls token 流）。前端据此尽早锁 reasoningDurationMs，避免
 *   把 tool_calls token 流的几秒算进「思考中」。content-having 轮不触发——
 *   onChunk 已处理锁定。
 * - tool_calls：LLM 本轮调用的全部工具调用（本轮 LLM 结束、tools 节点开跑前 yield）；
 * - assistant_done：本轮 LLM 完整结束（finish=stop 或 finish=tool_calls）。runner 据此
 *   持久化一条 session_messages.assistant；ReAct 多轮里会 emit 多次（每轮一次）。
 *   usage 跟随同一轮的 assistant_done 之后立即 yield。
 * - usage：调用结束的 token 用量。
 */
export type StreamChunk =
  | { kind: "human"; messageId: string }
  | { kind: "reasoning"; messageId: string; delta: string }
  | { kind: "chunk"; messageId: string; delta: string }
  | { kind: "reasoning_done"; messageId: string }
  | {
      kind: "tool_calls";
      messageId: string;
      /** LangChain AIMessage.tool_calls 原始数组（含 id/name/args）。 */
      toolCalls: unknown[];
    }
  | {
      kind: "tool_call_args";
      messageId: string;
      /** 该 tool_call 的稳定 id（前端据此合并增量到同一工具块）；流里无 id 时 undefined。 */
      toolCallId?: string;
      index: number;
      name?: string;
      delta: string;
    }
  | {
      kind: "assistant_done";
      messageId: string;
      content: string;
      reasoning: string;
      toolCalls: unknown[] | null;
    }
  | {
      kind: "usage";
      messageId: string;
      providerType: string;
      model: string;
      /** 模型配置显示名快照（resolver meta 无名字的旁路径为 undefined）。 */
      modelName?: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      reasoningTokens: number;
      durationMs: number;
    };
