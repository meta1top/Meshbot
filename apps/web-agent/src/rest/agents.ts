"use client";

import type {
  AgentCreateInput,
  AgentUpdateInput,
  AgentView,
  McpRawInput,
  PromptFileMeta,
} from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";
import { useQuery } from "@tanstack/react-query";

/** Agent 列表查询 key（Task 11/12 失效缓存时复用）。 */
export const agentsQueryKey = ["agents"] as const;

/** 当前账号的全部 Agent。 */
export async function listAgents(): Promise<AgentView[]> {
  const { data } = await apiClient.get<AgentView[]>("/api/agents");
  return data;
}

/** 创建 Agent。 */
export async function createAgent(input: AgentCreateInput): Promise<AgentView> {
  const { data } = await apiClient.post<AgentView>("/api/agents", input);
  return data;
}

/** 更新 Agent（只覆盖传入字段）。 */
export async function updateAgent(
  id: string,
  input: AgentUpdateInput,
): Promise<AgentView> {
  const { data } = await apiClient.patch<AgentView>(`/api/agents/${id}`, input);
  return data;
}

/** 删除 Agent（连同其全部会话、记忆、工作区一起清掉）。 */
export async function deleteAgent(id: string): Promise<void> {
  await apiClient.delete<void>(`/api/agents/${id}`);
}

/** 复制 Agent 的配置，返回新 Agent。「从现有 Agent 复制」入口已从编辑抽屉
 *  移出（见 agent-editor-v2 第三段：侧栏菜单「复制」项），本函数暂无调用方，
 *  留给该段接入。 */
export async function duplicateAgent(id: string): Promise<AgentView> {
  const { data } = await apiClient.post<AgentView>(
    `/api/agents/${id}/duplicate`,
  );
  return data;
}

/** 读取该 Agent 的 mcp.json 原始文本。 */
export async function getAgentMcp(id: string): Promise<McpRawInput> {
  const { data } = await apiClient.get<McpRawInput>(`/api/agents/${id}/mcp`);
  return data;
}

/** 写入该 Agent 的 mcp.json 原始文本。 */
export async function putAgentMcp(
  id: string,
  input: McpRawInput,
): Promise<void> {
  await apiClient.put<void>(`/api/agents/${id}/mcp`, input);
}

/** 列出该 Agent 的提示词文件（AGENT.md 恒首位）。 */
export async function listAgentPrompts(id: string): Promise<PromptFileMeta[]> {
  const { data } = await apiClient.get<PromptFileMeta[]>(
    `/api/agents/${id}/prompts`,
  );
  return data;
}

/** 读取单个提示词文件全文（不存在返回空字符串）。 */
export async function getAgentPrompt(
  id: string,
  file: string,
): Promise<{ content: string }> {
  const { data } = await apiClient.get<{ content: string }>(
    `/api/agents/${id}/prompts/${encodeURIComponent(file)}`,
  );
  return data;
}

/** 写入单个提示词文件（新建同一端点）。 */
export async function putAgentPrompt(
  id: string,
  file: string,
  content: string,
): Promise<void> {
  await apiClient.put<void>(
    `/api/agents/${id}/prompts/${encodeURIComponent(file)}`,
    { content },
  );
}

/** 删除单个提示词文件（AGENT.md 拒绝删除，由后端兜底）。 */
export async function deleteAgentPrompt(
  id: string,
  file: string,
): Promise<void> {
  await apiClient.delete<void>(
    `/api/agents/${id}/prompts/${encodeURIComponent(file)}`,
  );
}

/** 当前账号的 Agent 列表（Task 11/12 复用同一份缓存，失效走 agentsQueryKey）。 */
export function useAgents() {
  return useQuery({
    queryKey: agentsQueryKey,
    queryFn: listAgents,
  });
}
