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

/**
 * 已安装技能列表（Task 12：按 agentId 隔离——不传时后端兜底取账号默认
 * Agent，技能实际按 `agents/<agentId>/skills/` 落盘，传错/漏传会看到别的
 * Agent 的技能列表）。
 */
export async function fetchInstalled(
  agentId?: string,
): Promise<InstalledSkill[]> {
  const { data } = await apiClient.get<InstalledSkill[]>(
    "/api/skills/installed",
    { params: agentId ? { agentId } : undefined },
  );
  return data;
}

/** 安装技能（`input.agentId` 决定装到哪个 Agent 的 skills 目录）。 */
export async function installSkill(
  input: InstallSkillInput,
): Promise<InstalledSkill> {
  const { data } = await apiClient.post<InstalledSkill>(
    "/api/skills/install",
    input,
  );
  return data;
}

/** 卸载技能（Task 12：agentId 决定从哪个 Agent 的 skills 目录卸载）。 */
export async function uninstallSkill(
  name: string,
  agentId?: string,
): Promise<void> {
  await apiClient.delete<{ ok: true }>(
    `/api/skills/${encodeURIComponent(name)}`,
    { params: agentId ? { agentId } : undefined },
  );
}

/** 上传本地技能到我们的市场（`input.agentId` 决定从哪个 Agent 的本地技能目录读取）。 */
export async function publishSkill(
  input: PublishLocalSkillInput,
): Promise<void> {
  await apiClient.post<void>("/api/skills/publish", input);
}
