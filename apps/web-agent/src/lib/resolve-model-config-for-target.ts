import type { ComposerTarget } from "@/components/home/composer-target-bar";

/** 算 `defaultModelConfigId` 所需的最小 Agent 形状（避免拉整个 `AgentView`）。 */
export interface AgentModelDefault {
  id: string;
  defaultModelConfigId: string | null;
}

/**
 * 起手台切换选中目标（`ComposerTargetBar`）后，模型选择器该同步成什么值。
 *
 * 交互取舍：切 Agent 时把模型选择器**重置**成新 Agent 的 `defaultModelConfigId`
 * （覆盖用户本次会话里对上一个 Agent 做的手动选择）——这比「保留用户手动选的
 * 模型」更符合直觉：用户选中一个 Agent 本身就是在表达「按这个人格的默认方式跑」，
 * 各 Agent 的默认模型经常是精心配的（例如设计角色配读图模型），沿用旧 Agent
 * 手选的模型会让用户困惑「明明选了 Agent 怎么模型没变」。若用户在同一个 Agent
 * 内手动切模型，只要不再切 Agent，这次手动选择仍然生效（本函数只在 `target`
 * 变化时被调用，不会覆盖同一 Agent 内的手动切换）。
 *
 * 返回 `undefined` 表示「保持现状，不要动」而非「清空成账号默认」——两种情况：
 * 目标不是 agent（设备 / 未选择），或 Agent 列表还没加载 / 命中不到该 id（避免
 * react-query 尚未回包时把用户已经选好的模型误清空成账号默认）。
 *
 * `defaultModelConfigId` 允许为 `null`（跟随账号默认），调用方直接把 `null`
 * 原样传给 `setModelConfigId` 即可——`ModelSelect` 把 `null` 当作「账号默认
 * （首个 enabled）」渲染，不是「没选」。
 */
export function resolveModelConfigForTarget(
  target: ComposerTarget | null,
  agents: readonly AgentModelDefault[] | undefined,
): string | null | undefined {
  if (target?.kind !== "agent") return undefined;
  const agent = agents?.find((a) => a.id === target.id);
  if (!agent) return undefined;
  return agent.defaultModelConfigId;
}
