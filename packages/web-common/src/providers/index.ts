export interface ProviderDef {
  type: string;
  name: string;
  description: string;
  default_base_url: string;
  models: string[];
}

export const PROVIDERS: ProviderDef[] = [
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
];
