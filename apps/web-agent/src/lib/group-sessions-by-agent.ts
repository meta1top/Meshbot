import type { SessionSummary } from "@meshbot/types-agent";

/** 一个 Agent 的会话分组 + 是否有会话在跑（脉冲点用）。 */
export interface AgentSessionGroup {
  agentId: string;
  sessions: SessionSummary[];
  running: boolean;
}

/**
 * 把本机会话按归属 Agent 分组。agents 顺序决定分组顺序；零会话的 Agent 也保留。
 * running = 该 Agent 名下有 status==="running" 的会话。
 */
export function groupSessionsByAgent(
  agents: readonly { id: string }[],
  sessions: readonly SessionSummary[],
): AgentSessionGroup[] {
  return agents.map((a) => {
    const own = sessions.filter((sn) => sn.agentId === a.id);
    return {
      agentId: a.id,
      sessions: own,
      running: own.some((sn) => sn.status === "running"),
    };
  });
}
