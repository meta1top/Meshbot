import { z } from "zod";

export const modelConfigSchema = z.object({
  providerType: z.string().min(1, "请选择供应商"),
  name: z.string().min(1, "请输入名称"),
  model: z.string().min(1, "请输入或选择模型"),
  apiKey: z.string().min(1, "请输入 API Key"),
  baseUrl: z.string().optional(),
});

export type ModelConfigInput = z.infer<typeof modelConfigSchema>;
