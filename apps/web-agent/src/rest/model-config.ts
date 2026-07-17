import type { ModelConfigInput } from "@meshbot/types-agent";
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
  /** 配置来源：本地（可编辑/可删）或云端组织下发（只读，编辑走云端 web-main）。 */
  source: "cloud" | "local";
  createdAt: string;
  updatedAt: string;
}

/**
 * 模型配置合并视图：GET 返回本地 + 云端合并列表，每项按 `source` 标注来源。
 * 写操作（create/update/setEnabled/delete）只作用于本地 `source === 'local'` 行，
 * 改删云端条目由后端拒为 MODEL_CONFIG_READONLY（3018）。
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

/** 更新本地模型配置的可选字段（局部覆盖；不含 providerType，创建后不可改供应商）。 */
export interface ModelConfigUpdate {
  name?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  enabled?: boolean;
  contextWindow?: number;
}

/** 新建本地模型配置。 */
export async function createModelConfig(
  input: ModelConfigInput,
): Promise<ModelConfig> {
  const { data } = await apiClient.post<ModelConfig>(
    "/api/model-configs",
    input,
  );
  return data;
}

/** 更新本地模型配置（局部字段）。 */
export async function updateModelConfig(
  id: string,
  patch: ModelConfigUpdate,
): Promise<ModelConfig> {
  const { data } = await apiClient.patch<ModelConfig>(
    `/api/model-configs/${id}`,
    patch,
  );
  return data;
}

/** 切换本地模型配置的启用态。 */
export async function setModelConfigEnabled(
  id: string,
  enabled: boolean,
): Promise<ModelConfig> {
  const { data } = await apiClient.patch<ModelConfig>(
    `/api/model-configs/${id}/enabled`,
    { enabled },
  );
  return data;
}

/** 删除本地模型配置。 */
export async function deleteModelConfig(id: string): Promise<void> {
  await apiClient.delete(`/api/model-configs/${id}`);
}

/** 本地模型配置写操作后统一失效 `["model-configs"]`，重拉合并列表。 */
export function useModelConfigMutations() {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["model-configs"] });
  return {
    create: useMutation({
      mutationFn: createModelConfig,
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: ModelConfigUpdate }) =>
        updateModelConfig(v.id, v.patch),
      onSuccess: invalidate,
    }),
    setEnabled: useMutation({
      mutationFn: (v: { id: string; enabled: boolean }) =>
        setModelConfigEnabled(v.id, v.enabled),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: deleteModelConfig,
      onSuccess: invalidate,
    }),
  };
}
