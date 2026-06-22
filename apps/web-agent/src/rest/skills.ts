"use client";
import type {
  InstalledSkill,
  InstallSkillInput,
  MarketSkillSummary,
  PublishLocalSkillInput,
  SkillInstallSource,
} from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/** 浏览指定源的技能市场(可选关键字)。 */
export async function fetchMarket(
  source: SkillInstallSource,
  q?: string,
): Promise<MarketSkillSummary[]> {
  const { data } = await apiClient.get<MarketSkillSummary[]>(
    "/api/skills/market",
    {
      params: { source, ...(q ? { q } : {}) },
    },
  );
  return data;
}

/** 已安装技能列表。 */
export async function fetchInstalled(): Promise<InstalledSkill[]> {
  const { data } = await apiClient.get<InstalledSkill[]>(
    "/api/skills/installed",
  );
  return data;
}

/** 安装技能。 */
export async function installSkill(
  input: InstallSkillInput,
): Promise<InstalledSkill> {
  const { data } = await apiClient.post<InstalledSkill>(
    "/api/skills/install",
    input,
  );
  return data;
}

/** 卸载技能。 */
export async function uninstallSkill(name: string): Promise<void> {
  await apiClient.delete<{ ok: true }>(
    `/api/skills/${encodeURIComponent(name)}`,
  );
}

/** 上传本地技能到我们的市场。 */
export async function publishSkill(
  input: PublishLocalSkillInput,
): Promise<void> {
  await apiClient.post<void>("/api/skills/publish", input);
}
