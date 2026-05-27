"use client";

import type {
  StatsRange,
  StatsResponse,
  SuggestionsResponse,
} from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/** 取首页概览指标。 */
export async function fetchStats(range: StatsRange): Promise<StatsResponse> {
  const { data } = await apiClient.get<StatsResponse>(
    `/api/stats?range=${range}`,
  );
  return data;
}

/** 取"下一步行动建议"。 */
export async function fetchSuggestions(): Promise<SuggestionsResponse> {
  const { data } = await apiClient.get<SuggestionsResponse>("/api/suggestions");
  return data;
}
