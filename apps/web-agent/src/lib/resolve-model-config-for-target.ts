import { type LauncherTarget, launcherTargetKey } from "@/lib/launcher-target";

/** 算 `defaultModelConfigId` 所需的最小 Agent 形状（避免拉整个 `AgentView`）。 */
export interface AgentModelDefault {
  id: string;
  defaultModelConfigId: string | null;
}

/**
 * 起手台切换目标后模型选择器该同步成什么值。只有本机 target（scope==="local"）
 * 才有可联动的 `defaultModelConfigId`；远程 / null / agents 未加载 / 命中不到 →
 * `undefined`（保持现状，不动模型选择器）。`null` 表示「账号默认」，与 `undefined`
 * （不要动）语义不同，绝不能混淆。
 */
export function resolveModelConfigForTarget(
  target: LauncherTarget | null,
  agents: readonly AgentModelDefault[] | undefined,
): string | null | undefined {
  if (target?.scope !== "local") return undefined;
  const agent = agents?.find((a) => a.id === target.agentId);
  if (!agent) return undefined;
  return agent.defaultModelConfigId;
}

/**
 * 「切 target 联动模型选择器」的一步纯函数（原 bug #8：agents 内容变化——非
 * target 切换——不应覆盖用户手选）。只有 `launcherTargetKey(target)` 相对上次
 * 已联动 key 变化才允许覆盖；agents 数组变化但 target 未变时原样跳过。
 */
export function nextModelOnTargetChange(
  prevKey: string | null,
  target: LauncherTarget | null,
  agents: readonly AgentModelDefault[] | undefined,
): { nextKey: string | null; value: string | null | undefined } {
  const key = launcherTargetKey(target);
  if (key === prevKey) return { nextKey: prevKey, value: undefined };
  if (target?.scope !== "local") return { nextKey: key, value: undefined };
  const value = resolveModelConfigForTarget(target, agents);
  if (value === undefined) return { nextKey: prevKey, value: undefined };
  return { nextKey: key, value };
}
