import { z } from "zod";

/**
 * 模型供应商描述。后端 `GET /api/providers` 与前端 setup 表单
 * 共用同一份元数据。
 */
export interface ProviderDef {
  type: string;
  name: string;
  description: string;
  default_base_url: string;
  models: string[];
}

/**
 * meshbot 支持的模型供应商清单。
 *
 * 来源：原 `packages/web-common/src/providers/index.ts`，迁移至
 * `libs/types-agent/src/ai/` 以消除「后端 → 前端 package」的反向依赖
 * （server-agent 之前直接从 `@meshbot/web-common` 取 PROVIDERS）。
 */
export const PROVIDERS: readonly ProviderDef[] = [
  {
    type: "openai",
    name: "OpenAI",
    description: "GPT-4o, GPT-4.1 等系列模型",
    default_base_url: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4o-mini"],
  },
  {
    type: "anthropic",
    name: "Anthropic",
    description: "Claude Opus, Sonnet, Haiku 系列模型",
    default_base_url: "https://api.anthropic.com",
    models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  {
    type: "google",
    name: "Google Generative AI",
    description: "Gemini 系列模型",
    default_base_url: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    type: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek V4 系列模型",
    default_base_url: "https://api.deepseek.com",
    models: ["deepseek-v4-pro", "deepseek-chat"],
  },
  {
    type: "ollama",
    name: "Ollama",
    description: "本地运行的开源模型",
    default_base_url: "http://localhost:11434",
    models: [],
  },
  {
    type: "openai-compatible",
    name: "OpenAI 兼容接口",
    description: "任何兼容 OpenAI API 格式的服务（如 OpenRouter、vLLM 等）",
    default_base_url: "",
    models: [],
  },
] as const;

/**
 * 模型配置表单 Schema（setup / model-form 共用）。
 */
export const modelConfigSchema = z.object({
  providerType: z.string().min(1, "请选择供应商"),
  name: z.string().min(1, "请输入名称"),
  model: z.string().min(1, "请输入或选择模型"),
  apiKey: z.string().min(1, "请输入 API Key"),
  baseUrl: z.string().optional(),
});

export type ModelConfigInput = z.infer<typeof modelConfigSchema>;
