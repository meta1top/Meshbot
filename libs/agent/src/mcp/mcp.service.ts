import { existsSync, readFileSync } from "node:fs";
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
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

/**
 * MCP 集成入口。生命周期：
 *
 * - `onModuleInit`：读 `<meshbotDir>/mcp.json`，启动 MultiServerMCPClient，
 *   拉所有 tool，按 `mcp__<server>__<tool>` 命名注册进 ToolRegistry。
 *   单个 server 连不上不影响其他（best-effort，由 `onConnectionError: "ignore"` 保障）。
 *
 * - `onModuleDestroy`：调 `client.close()` 关掉所有子进程 / 长连接。
 *
 * mcp.json 不存在或 `mcpServers` 为空时直接跳过，不抛错。
 */
@Injectable()
export class McpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);
  private client: MultiServerMCPClient | null = null;
  /** 已注册到 ToolRegistry 的 tool name，用于 destroy 时反注册。 */
  private readonly registeredNames = new Set<string>();

  constructor(
    private readonly config: MeshbotConfigService,
    private readonly registry: ToolRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    const cfg = this.loadConfig();
    if (!cfg || Object.keys(cfg.mcpServers).length === 0) {
      return;
    }
    const mcpServers = mapServersToLangchainShape(cfg.mcpServers);
    this.client = new MultiServerMCPClient({
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
    let tools: StructuredToolInterface[];
    try {
      tools = (await this.client.getTools()) as StructuredToolInterface[];
    } catch (err) {
      this.logger.error(
        `Failed to load MCP tools: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const lcTool of tools) {
      try {
        const { meshbot } = buildMcpToolAdapter(lcTool);
        this.registry.register(meshbot, lcTool);
        this.registeredNames.add(meshbot.name);
      } catch (err) {
        // 重名等注册失败时打日志，不抛 —— 避免一颗坏 tool 阻断其他 server。
        this.logger.warn(
          `Skip MCP tool "${lcTool.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.log(
      `MCP ready: ${this.registeredNames.size} tools from ${Object.keys(mcpServers).length} server(s).`,
    );
  }

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

  /** 读 & 校验 mcp.json。文件不存在返 null；解析失败抛错（配置写坏应当被发现）。 */
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
