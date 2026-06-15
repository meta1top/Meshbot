import { existsSync, readFileSync } from "node:fs";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { ToolRegistry } from "../tools/tool-registry";
import { buildMcpToolAdapter } from "./mcp-tool.adapter";
import {
  type McpConfig,
  type McpServerConfig,
  McpConfigSchema,
  isStdioServer,
} from "./mcp.schema";

/** 单账号的 MCP 运行态：client + 已注册到该账号的 tool name 集合。 */
interface AccountMcp {
  client: MultiServerMCPClient;
  names: Set<string>;
}

/**
 * MCP 集成入口（v3 按账号隔离）。生命周期：
 *
 * - 启动期**不再**全局加载 mcp.json —— mcp.json 按账号存放在
 *   `<meshbotDir>/accounts/<account>/mcp.json`，需在账号上下文内读取。
 *   每账号 init/teardown 由上层（Task 3.5 registry）驱动。
 *
 * - `onModuleDestroy`：拆掉所有账号的 client，关子进程 / 长连接。
 */
@Injectable()
export class McpService implements OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);

  /** cloudUserId → 该账号的 MCP 运行态。 */
  private readonly perAccount = new Map<string, AccountMcp>();

  constructor(
    private readonly config: MeshbotConfigService,
    private readonly registry: ToolRegistry,
  ) {}

  /**
   * 为指定账号加载 mcp.json、启动 MCP client、把所有 tool 注册到该账号名下。
   *
   * **契约：必须在 `accountContext.run(cloudUserId, ...)` 内调用** —— loadConfig
   * 读的是账号化路径 `getMcpConfigPath()`，依赖 ALS 当前账号；脱离账号上下文会抛
   * NO_ACCOUNT_CONTEXT。传入的 cloudUserId 应与当前账号上下文一致。
   *
   * 幂等：先 teardown 旧运行态再重建，重复调用不会泄漏 client。mcp.json 不存在
   * 或无 server 时直接返回，不注册任何 tool。单个 tool 注册失败只打日志不中断。
   *
   * @param cloudUserId 账号 ID（= JWT sub）
   */
  async initAccount(cloudUserId: string): Promise<void> {
    await this.teardownAccount(cloudUserId);
    const cfg = this.loadConfig();
    if (!cfg || Object.keys(cfg.mcpServers).length === 0) {
      return;
    }
    const mcpServers = mapServersToLangchainShape(cfg.mcpServers);
    const client = this.createClient(mcpServers);
    const names = new Set<string>();
    try {
      const tools = (await client.getTools()) as StructuredToolInterface[];
      for (const lcTool of tools) {
        try {
          const { meshbot } = buildMcpToolAdapter(lcTool);
          this.registry.registerForAccount(cloudUserId, meshbot, lcTool);
          names.add(meshbot.name);
        } catch (err) {
          // 单颗 tool 适配 / 注册失败只跳过，不拖垮其他 server。
          this.logger.warn(
            `Skip MCP tool "${lcTool.name}" for ${cloudUserId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to load MCP tools for ${cloudUserId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        await client.close();
      } catch {
        // best-effort 清理，已记主错。
      }
      return;
    }
    this.perAccount.set(cloudUserId, { client, names });
    this.logger.log(
      `MCP ready for ${cloudUserId}: ${names.size} tools from ${Object.keys(mcpServers).length} server(s).`,
    );
  }

  /**
   * 拆掉指定账号的 MCP 运行态：反注册该账号全部 tool，关闭 client。
   * 幂等：账号未 init 时直接返回。
   *
   * @param cloudUserId 账号 ID（= JWT sub）
   */
  async teardownAccount(cloudUserId: string): Promise<void> {
    const entry = this.perAccount.get(cloudUserId);
    if (!entry) {
      return;
    }
    this.perAccount.delete(cloudUserId);
    this.registry.unregisterAccount(cloudUserId);
    try {
      await entry.client.close();
    } catch (err) {
      this.logger.warn(
        `MCP client close error for ${cloudUserId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const cloudUserId of [...this.perAccount.keys()]) {
      await this.teardownAccount(cloudUserId);
    }
  }

  /**
   * 构造 MultiServerMCPClient。抽成可覆盖方法，便于测试用 stub 替换真 client。
   */
  protected createClient(
    mcpServers: Record<string, Record<string, unknown>>,
  ): MultiServerMCPClient {
    return new MultiServerMCPClient({
      // mcp-adapters 期望 union 类型；我们的 schema 已收敛到 stdio | http/sse 二选一，
      // 但 union narrowing 走运行期判别（isStdioServer），TS 不能从 record 整体推回。
      mcpServers: mcpServers as never,
      // 单 server 连不上不要拖垮整个 agent；写日志即可。
      onConnectionError: "ignore",
      throwOnLoadError: false,
      prefixToolNameWithServerName: true,
      additionalToolNamePrefix: "mcp",
      useStandardContentBlocks: true,
    });
  }

  /**
   * 读 & 校验当前账号的 mcp.json（账号化路径）。文件不存在返 null；
   * JSON / schema 解析失败打日志返 null（配置写坏应被发现，但不拖垮启动）。
   */
  private loadConfig(): McpConfig | null {
    const path = this.config.getMcpConfigPath();
    if (!existsSync(path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      this.logger.error(
        `Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    const parsed = McpConfigSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error(
        `mcp.json schema validation failed: ${parsed.error.message}`,
      );
      return null;
    }
    return parsed.data;
  }
}

/**
 * 把我们 mcp.json 的 server 配置转成 @langchain/mcp-adapters 期望的形状：
 * - stdio：补 `transport: "stdio"` + 默认空 args
 * - http/sse：补 `transport: "streamable_http"`（默认）或用户指定的 transport
 */
function mapServersToLangchainShape(
  servers: Record<string, McpServerConfig>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (isStdioServer(cfg)) {
      out[name] = {
        transport: "stdio",
        command: cfg.command,
        args: cfg.args ?? [],
        ...(cfg.env ? { env: cfg.env } : {}),
      };
    } else {
      out[name] = {
        transport: cfg.transport ?? "streamable_http",
        url: cfg.url,
        ...(cfg.headers ? { headers: cfg.headers } : {}),
      };
    }
  }
  return out;
}
