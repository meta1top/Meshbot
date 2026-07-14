import {
  AccountContextService,
  McpService,
  PromptService,
} from "@meshbot/lib-agent";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import { AgentService } from "../services/agent.service";
import { ACCOUNT_EVENTS } from "./account.events";

/**
 * 每账号运行时注册表（v3）：登录 createRuntime / 登出 teardownRuntime / 改配置 reloadRuntime。
 * 运行时 = MCP 连接 + 技能/提示词缓存 + 云端（IM relay）连接。
 */
@Injectable()
export class AccountRuntimeRegistry {
  private readonly logger = new Logger(AccountRuntimeRegistry.name);
  private readonly live = new Set<string>();

  constructor(
    private readonly ctx: AccountContextService,
    private readonly mcp: McpService,
    private readonly prompt: PromptService,
    private readonly relay: ImRelayClientService,
    private readonly emitter: EventEmitter2,
    private readonly agents: AgentService,
  ) {}

  /** 该账号运行时是否在线。 */
  has(cloudUserId: string): boolean {
    return this.live.has(cloudUserId);
  }

  /**
   * 构建某账号运行时（幂等：已存在先 teardown）。
   *
   * MCP 已改为按 Agent 懒加载（Task 6）：不再在登录时预热任何 Agent 的 MCP，
   * 首次使用该 Agent（RunnerService 建流前）才由 `McpService.ensureAgent` 拉起。
   */
  async createRuntime(cloudUserId: string): Promise<void> {
    await this.teardownRuntime(cloudUserId);
    await this.ctx.run(cloudUserId, async () => {
      await this.agents.ensureDefault();
    });
    await this.relay.connect(cloudUserId);
    this.live.add(cloudUserId);
    this.emitter.emit(ACCOUNT_EVENTS.runtimeCreated, { cloudUserId });
  }

  /**
   * 拆除某账号运行时（卸 MCP/技能/提示词/云连接）。幂等。满足登出卸载。
   * 登出时必须不抛出，单步失败只记录日志，其余步骤继续执行。
   */
  async teardownRuntime(cloudUserId: string): Promise<void> {
    try {
      await this.mcp.teardownAccount(cloudUserId);
    } catch (err) {
      this.logger.error(`teardown MCP ${cloudUserId} 失败`, err as Error);
    }
    try {
      this.prompt.evict(cloudUserId);
    } catch (err) {
      this.logger.error(`evict prompt ${cloudUserId} 失败`, err as Error);
    }
    try {
      this.relay.disconnect(cloudUserId);
    } catch (err) {
      this.logger.error(`disconnect relay ${cloudUserId} 失败`, err as Error);
    }
    this.live.delete(cloudUserId);
    this.emitter.emit(ACCOUNT_EVENTS.runtimeTeardown, { cloudUserId });
  }

  /** 改配置/切目录时重载（teardown + create）。 */
  async reloadRuntime(cloudUserId: string): Promise<void> {
    await this.createRuntime(cloudUserId);
  }
}
