import { z } from "zod";

/**
 * OpenAI `chat/completions` 请求体的最小兼容 schema。
 *
 * 云端模型网关（server-main）用它校验入站请求，再转成 langchain 消息
 * （见 `apps/server-main/src/model-gateway/openai-adapter.ts`）。
 */
export const openAIChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.union([z.string(), z.null()]).optional(),
      tool_calls: z.array(z.any()).optional(),
      tool_call_id: z.string().optional(),
      name: z.string().optional(),
    }),
  ),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
});

export type OpenAIChatRequest = z.infer<typeof openAIChatRequestSchema>;
