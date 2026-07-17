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

/** `target` 的身份 key（`kind:id`），null = 未选择目标。用于判断「target 是否
 * 真的切换了」而非仅仅引用变化——`useAgents()` 的 react-query 数据在别处
 * 增/删/改名后拿到新数组引用，但 target 本身没变时不能算「切换」。 */
export function targetKey(target: ComposerTarget | null): string {
  return target ? `${target.kind}:${target.id}` : "none";
}

/**
 * 起手台「切 target 联动模型选择器」的一步纯函数（原 bug #8 残留：`useEffect`
 * 依赖 `agents` 时，agents 内容真变化——非 target 切换——也会重跑并把用户刚
 * 手选的模型覆盖回 Agent 默认值）。
 *
 * 语义：只有 `target` 的身份（`targetKey`）相对上次已联动的 key 发生变化，才
 * 允许覆盖 `modelConfigId`；agents 数组变化但 target 未变时必须原样跳过。
 *
 * @param prevKey 上次已经完成联动（或已确认「本次 target 不需要联动」）的 key；
 *   初始为 `null`。
 * @returns `nextKey`——调用方应把它写回 ref，作为下次调用的 `prevKey`；
 *   `value`——`undefined` 表示不要动 `modelConfigId`，否则原样 `setModelConfigId`。
 *
 * 三种分支：
 * 1. `targetKey(target) === prevKey`：target 身份没变（agents 内容变化触发的
 *    重跑）→ 不联动，`nextKey` 原样透传。
 * 2. target 不是 agent（设备 / 未选择）：没有默认模型可联动，但仍要把新 key
 *    记下来（`nextKey` 更新），这样以后切回同一个 agent 才会被当成「新的一次
 *    切换」重新触发联动——否则会因为 key 停留在切走前的旧 agent 而被分支 1
 *    误判成「没变」。
 * 3. target 是 agent 且身份变了：尝试 `resolveModelConfigForTarget`。若暂时
 *    解不出（agents 未加载 / 命中不到该 id，返回 `undefined`）→ `nextKey` 原样
 *    透传（不算已联动，留给下次 agents 变化时重试）；解出确定值（含合法的
 *    `null` = 账号默认）→ `nextKey` 更新为新 key 并把该值写回。
 */
export function nextModelOnTargetChange(
  prevKey: string | null,
  target: ComposerTarget | null,
  agents: readonly AgentModelDefault[] | undefined,
): { nextKey: string | null; value: string | null | undefined } {
  const key = targetKey(target);
  if (key === prevKey) return { nextKey: prevKey, value: undefined };
  if (target?.kind !== "agent") return { nextKey: key, value: undefined };
  const value = resolveModelConfigForTarget(target, agents);
  if (value === undefined) return { nextKey: prevKey, value: undefined };
  return { nextKey: key, value };
}
