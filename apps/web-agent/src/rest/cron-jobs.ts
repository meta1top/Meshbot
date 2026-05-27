"use client";

import type {
  CreateCronJobInput,
  CronJobDto,
  CronJobListResponse,
  PatchCronJobInput,
} from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/** 列出所有计划任务（可按 sessionId 过滤）。 */
export async function listCronJobs(opts?: {
  sessionId?: string;
}): Promise<CronJobListResponse> {
  const { data } = await apiClient.get<CronJobListResponse>("/api/cron-jobs", {
    params: opts?.sessionId ? { sessionId: opts.sessionId } : undefined,
  });
  return data;
}

/** 创建计划任务。 */
export async function createCronJob(
  input: CreateCronJobInput,
): Promise<CronJobDto> {
  const { data } = await apiClient.post<CronJobDto>("/api/cron-jobs", input);
  return data;
}

/** 修改 enabled / title。 */
export async function patchCronJob(
  id: string,
  input: PatchCronJobInput,
): Promise<CronJobDto> {
  const { data } = await apiClient.patch<CronJobDto>(
    `/api/cron-jobs/${id}`,
    input,
  );
  return data;
}

/** 删除一条。 */
export async function deleteCronJob(id: string): Promise<{ deleted: true }> {
  const { data } = await apiClient.delete<{ deleted: true }>(
    `/api/cron-jobs/${id}`,
  );
  return data;
}
