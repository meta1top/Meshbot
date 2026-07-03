import { apiClient } from "@meshbot/web-common";
import { useQuery } from "@tanstack/react-query";

export interface ModelConfig {
  id: string;
  providerType: string;
  name: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  /** 上下文窗口（token），后端按 MODEL_SPECS 或用户覆盖解析后固化。 */
  contextWindow: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 模型配置只读展示（编辑已收敛到云端 web-main）。
 */
export async function fetchModelConfigs(): Promise<ModelConfig[]> {
  const { data } = await apiClient.get<ModelConfig[]>("/api/model-configs");
  return data;
}

export function useModelConfigs() {
  return useQuery({
    queryKey: ["model-configs"],
    queryFn: fetchModelConfigs,
  });
}
