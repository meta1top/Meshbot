import type { RemoteAgentView, SessionSummary } from "@meshbot/types-agent";

export interface RemoteSessionHeaderView {
  /** 会话标题；session 数据未到位（该远程 Agent 的会话列表还在加载 / 该会话
   *  尚未出现在已加载的列表里）时降级为 fallbackTitle，绝不空白。 */
  title: string;
  /** Agent 身份信息（头像 + 名 + 宿主设备名）；远程 Agent 列表未到位或未命中
   *  该 agentId 时为 null——不渲染身份徽标（不是骨架、不是占位空块）。 */
  agent: { name: string; avatar: string; deviceName: string } | null;
}

/**
 * 远程会话标题栏的展示态计算（真机验收缺陷 2：原实现无条件写死「远程会话」
 * 文案，不管数据是否已到位）。
 *
 * 纯函数抽出的是「数据未到位时怎么降级」这条决策，脱离 jotai/react-query 单测，
 * 覆盖两个会在真机上真实发生的中间态：
 * - agent 未到位（远程 Agent 列表还在拉 / 未命中该 id）→ `agent: null`，不渲染
 *   身份徽标，但标题区仍必须有内容——不能空白/卡骨架，这正是原 bug 想规避的
 *   另一种更差的形态。
 * - session 未到位（该远程 Agent 的会话列表还没加载完，或该会话是刚发起、尚未
 *   出现在已加载列表里的新会话）→ 标题降级为 `fallbackTitle`（即原来写死的那句
 *   文案，现在只在这个过渡态短暂出现，数据一到就自动换成真实标题）。
 */
export function resolveRemoteSessionHeaderView(params: {
  agent: Pick<RemoteAgentView, "name" | "avatar" | "deviceName"> | undefined;
  session: Pick<SessionSummary, "title"> | undefined;
  fallbackTitle: string;
}): RemoteSessionHeaderView {
  return {
    title: params.session?.title ?? params.fallbackTitle,
    agent: params.agent
      ? {
          name: params.agent.name,
          avatar: params.agent.avatar,
          deviceName: params.agent.deviceName,
        }
      : null,
  };
}
