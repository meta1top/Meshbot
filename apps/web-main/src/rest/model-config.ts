import type { OrgModelConfigView } from "@meshbot/types";
import type {
  OrgModelConfigCreateInput,
  OrgModelConfigUpdateInput,
} from "@meshbot/types-main";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { mainApi } from "@/lib/api";

/**
 * 组织级模型配置管理 hooks（web-main `/settings/models` 页用，owner 限定写）。
 * `apiKeyMasked` 打码视图，更新时 apiKey 缺省表示不换。
 */

const MODEL_CONFIGS_QUERY_KEY = (orgId: string) =>
  ["main", "org", orgId, "model-configs"] as const;

/** 配置列表。 */
export function useModelConfigs(
  orgId: string | null,
): UseQueryResult<OrgModelConfigView[]> {
  return useQuery({
    queryKey: MODEL_CONFIGS_QUERY_KEY(orgId ?? ""),
    queryFn: async () =>
      (
        await mainApi.get<OrgModelConfigView[]>(
          `/api/orgs/${orgId}/model-configs`,
        )
      ).data,
    enabled: orgId != null,
  });
}

/** 新建配置。成功后 invalidate 配置列表。 */
export function useCreateModelConfig(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: OrgModelConfigCreateInput) =>
      (
        await mainApi.post<OrgModelConfigView>(
          `/api/orgs/${orgId}/model-configs`,
          input,
        )
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: MODEL_CONFIGS_QUERY_KEY(orgId),
      });
    },
  });
}

/** 更新配置（全字段可选，apiKey 缺省表示不换）。成功后 invalidate 配置列表。 */
export function useUpdateModelConfig(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      configId,
      input,
    }: {
      configId: string;
      input: OrgModelConfigUpdateInput;
    }) =>
      (
        await mainApi.patch<OrgModelConfigView>(
          `/api/orgs/${orgId}/model-configs/${configId}`,
          input,
        )
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: MODEL_CONFIGS_QUERY_KEY(orgId),
      });
    },
  });
}

/** 删除配置。成功后 invalidate 配置列表。 */
export function useDeleteModelConfig(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (configId: string) =>
      (
        await mainApi.delete<{ ok: true }>(
          `/api/orgs/${orgId}/model-configs/${configId}`,
        )
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: MODEL_CONFIGS_QUERY_KEY(orgId),
      });
    },
  });
}
