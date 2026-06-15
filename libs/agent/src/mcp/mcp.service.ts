import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { ToolRegistry } from "../tools/tool-registry";

/**
 * MCP 集成入口。生命周期：
 *
 * - 启动期**不再**全局加载 mcp.json —— Phase 3 起 mcp.json 按账号隔离
 *   （`<meshbotDir>/accounts/<account>/mcp.json`），而启动期无账号上下文，
 *   调用账号化 getter（getMcpConfigPath）会抛 NO_ACCOUNT_CONTEXT 拖垮启动。
 *   读 mcp.json + 启动 client + 注册 tool 的逻辑改为按账号 initAccount，在 Task 3.3 实现。
 *
 * - `onModuleDestroy`：调 `client.close()` 关掉所有子进程 / 长连接。
 *   当前 client 恒为 null（启动不再连），属无害保留，Task 3.3 接管 client 生命周期。
 */
@Injectable()
export class McpService implements OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);
  private client: MultiServerMCPClient | null = null;
  /** 已注册到 ToolRegistry 的 tool name，用于 destroy 时反注册。 */
  private readonly registeredNames = new Set<string>();

  constructor(private readonly registry: ToolRegistry) {}

  async onModuleDestroy(): Promise<void> {
    for (const name of this.registeredNames) {
      this.registry.unregister(name);
    }
    this.registeredNames.clear();
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        this.logger.warn(
          `MCP client close error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.client = null;
    }
  }
}
