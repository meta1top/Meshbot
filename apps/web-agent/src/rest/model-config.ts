import type { ModelConfigInput, ProviderDef } from "@meshbot/web-common";
import { apiClient } from "@meshbot/web-common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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

export async function fetchProviders(): Promise<ProviderDef[]> {
  const { data } = await apiClient.get<ProviderDef[]>("/api/providers");
  return data;
}

export async function fetchModelConfigs(): Promise<ModelConfig[]> {
  const { data } = await apiClient.get<ModelConfig[]>("/api/model-configs");
  return data;
}

export async function createModelConfig(
  input: ModelConfigInput,
): Promise<ModelConfig> {
  const { data } = await apiClient.post<ModelConfig>(
    "/api/model-configs",
    input,
  );
  return data;
}

export function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: fetchProviders,
  });
}

export function useModelConfigs() {
  return useQuery({
    queryKey: ["model-configs"],
    queryFn: fetchModelConfigs,
  });
}

export function useCreateModelConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createModelConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["model-configs"] });
    },
  });
}
