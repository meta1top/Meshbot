import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";

interface AgentStore {
  agentId: string;
}

/**
 * 进程内「当前 Agent 上下文」。
 *
 * 一个账号下可有多个 Agent，各自独立的人格/技能/MCP/记忆/工作区。本 ALS 承载
 * 当前 run（或当前 REST 请求）作用的 agentId：
 * - run 路径：RunnerService 读 session.agentId，包住「建流 + for-await」整段。
 * - REST 路径：Controller 从请求参数取 agentId 显式 run()。
 *
 * MeshbotConfigService 的路径 getter 从这里取 agentId 拼 agents/<agentId>/...，
 * 因此 SkillService / MemoryService / 文件工具零改动自动按 Agent 隔离。
 */
@Injectable()
export class AgentContextService {
  private readonly als = new AsyncLocalStorage<AgentStore>();

  /** 在指定 Agent 上下文中运行 fn（同步或异步）。 */
  run<T>(agentId: string, fn: () => T): T {
    return this.als.run({ agentId }, fn);
  }

  /** 当前 agentId；无上下文返回 null。 */
  get(): string | null {
    return this.als.getStore()?.agentId ?? null;
  }

  /**
   * 当前 agentId；无上下文抛错（内部不变量：Agent 化文件访问必须在 Agent 上下文内，
   * 触发说明存在编程错误）。
   */
  getOrThrow(): string {
    const id = this.get();
    if (!id) {
      throw new Error(
        "AgentContext: 当前无活跃 Agent 上下文（Agent 化文件访问运行在 Agent 上下文之外）",
      );
    }
    return id;
  }
}
