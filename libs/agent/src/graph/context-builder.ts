import { SystemMessage } from "@langchain/core/messages";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { AccountContextService } from "../account/account-context.service.js";
import { AgentContextService } from "../account/agent-context.service.js";
import { MEMORY_GUIDE } from "../memory/memory-guide.js";
import { MemoryService } from "../memory/memory.service.js";
import { isStdioServer, type McpServerConfig } from "../mcp/mcp.schema.js";
import { McpService } from "../mcp/mcp.service.js";
import { LLMUSE_GUIDE } from "../prompt/llmuse-guide.js";
import { SkillService } from "../skills/skill.service.js";
import type { ThreadId } from "./graph.types.js";
import { ModelResolver } from "./model-resolver.service.js";
import {
  RUNTIME_CONTEXT_PORT,
  type RuntimeContextPort,
} from "./runtime-context.port.js";

/**
 * 组装 `<skills>` 系统块内容：已装技能的「名字 + 完整描述」目录。
 *
 * 这是「目录常驻、内容按需」：让 agent 始终知道有哪些技能(否则要先 skill_list 才知道)，
 * 完整 SKILL.md 仍由 skill_load 渐进加载。描述不截断,完整呈现。
 * 无技能时给出搜索/安装引导,避免空块。
 */
export function buildSkillsBlock(
  entries: { name: string; description: string }[],
): string {
  if (entries.length === 0) {
    return [
      "<skills>",
      "当前未安装任何技能。需要某类能力时用 skill_search_market 搜索市场，再 skill_install 安装。",
      "</skills>",
    ].join("\n");
  }
  const lines = entries.map((e) =>
    e.description ? `- ${e.name}: ${e.description}` : `- ${e.name}`,
  );
  return [
    "<skills>",
    "已安装技能（按需用 skill_load <name> 加载完整说明后再执行；更多能力用 skill_search_market 搜索市场再 skill_install）:",
    ...lines,
    "</skills>",
  ].join("\n");
}

/**
 * 组装 `<mcp>` 系统块内容：MCP 工具命名格式说明 + 管理工具引导 + 当前 Agent 的
 * server 清单（含启用态与本轮加载态）。
 *
 * 与 `buildSkillsBlock` 同范式：agent 始终知道自己装了哪些 MCP server，
 * 无需先调 mcp_list 才知道。清单**包含禁用项**（标「已禁用」，配置仍保留）。
 * 无任何配置时替换为安装引导，避免空块。
 *
 * @param servers 配置态全量 server（含禁用项），来自 `McpService.loadConfig()`
 * @param loadedNames 运行态已加载的完整工具名集合（`mcp__<server>__<tool>`）；
 *   null 表示本轮尚未加载（不能等同于「0 个工具」，需用「未加载」区分）
 */
export function buildMcpBlock(
  servers: Record<string, McpServerConfig>,
  loadedNames: ReadonlySet<string> | null,
): string {
  const intro = [
    "名字形如 mcp__<server>__<tool> 的工具来自 MCP 服务器，由本 Agent 的 mcp.json 配置加载。",
    "你可以用 mcp_list / mcp_install / mcp_uninstall / mcp_enable / mcp_disable 管理这些服务器（安装需用户确认；变更下一轮对话生效）。",
  ];
  const names = Object.keys(servers);
  if (names.length === 0) {
    return [
      "<mcp>",
      ...intro,
      "当前未配置任何 MCP 服务器。需要外部工具能力时可用 mcp_install 安装（需用户确认）。",
      "</mcp>",
    ].join("\n");
  }
  const lines = names.map((name) => {
    const cfg = servers[name];
    const protocol = isStdioServer(cfg)
      ? "stdio"
      : (cfg.transport ?? "streamable_http");
    const enabled = cfg.enabled === false ? "已禁用" : "已启用";
    const loadState =
      loadedNames === null
        ? "未加载"
        : `本轮已加载 ${countToolsForServer(loadedNames, name)} 个工具`;
    return `- ${name}（${protocol}，${enabled}，${loadState}）`;
  });
  return ["<mcp>", ...intro, "已配置的 MCP 服务器:", ...lines, "</mcp>"].join(
    "\n",
  );
}

/** 数已加载工具名集合里属于某 server 的个数（前缀 `mcp__<server>__`）。 */
function countToolsForServer(
  loadedNames: ReadonlySet<string>,
  serverName: string,
): number {
  const prefix = `mcp__${serverName}__`;
  let count = 0;
  for (const name of loadedNames) {
    if (name.startsWith(prefix)) count += 1;
  }
  return count;
}

/** 负责组装系统上下文消息、记忆段落、技能目录消息。 */
@Injectable()
export class ContextBuilder {
  constructor(
    private readonly account: AccountContextService,
    private readonly agentCtx: AgentContextService,
    @Optional()
    @Inject(RUNTIME_CONTEXT_PORT)
    private readonly runtimeContext?: RuntimeContextPort,
    @Optional() private readonly memory?: MemoryService,
    @Optional() private readonly skills?: SkillService,
    private readonly modelResolver?: ModelResolver,
    @Optional() private readonly mcp?: McpService,
  ) {}

  /**
   * 组装记忆段落，追加至系统提示末尾。
   *
   * 始终包含 MEMORY_GUIDE（工具使用规范）。
   * 若 core.md 非空，额外拼接 `<memory>...</memory>` 块（常驻精炼画像）。
   * 无 MemoryService 注入时返回空字符串（整段省略），不影响既有 harness。
   */
  buildMemorySection(): string {
    const core = this.memory?.readCore() ?? "";
    if (!core) {
      return MEMORY_GUIDE;
    }
    return `${MEMORY_GUIDE}\n\n<memory>\n${core}\n</memory>`;
  }

  /** 组装运行时上下文消息（稳定 id system:ctx；每 run 刷新；不含易变 now）。 */
  async buildContextMessage(threadId: ThreadId): Promise<SystemMessage> {
    const cloudUserId = this.account.getOrThrow();
    const ext = this.runtimeContext
      ? await this.runtimeContext.resolve()
      : null;
    const tz =
      ext?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // 注入当前 Agent 自己的名字（用户可改）：所有会话类型一致，让 agent 始终知道自己叫什么
    const lines = [
      `cloudUserId: ${cloudUserId}`,
      `sessionId: ${threadId}`,
      ...(ext?.displayName ? [`user: ${ext.displayName}`] : []),
      ...(ext?.agentName
        ? [`assistantName: ${ext.agentName}（你自己的名字）`]
        : []),
      `model: ${this.modelResolver?.getMeta().model ?? ""}`,
      ...(ext?.language ? [`language: ${ext.language}`] : []),
      `timezone: ${tz}`,
    ];
    return new SystemMessage({
      id: "system:ctx",
      content: `<context>\n${lines.join("\n")}\n</context>`,
    });
  }

  /**
   * 组装人格消息（稳定 id system:persona；**每轮刷新**、reducer 按 id 原地更新）。
   *
   * 内容 = 当前 Agent 的 systemPrompt + 记忆段（MEMORY_GUIDE + core.md）+ LLMUSE 指南。
   *
   * 必须每轮刷新而非首轮注入：多 Agent 下用户随时可改 systemPrompt 或切换 Agent，
   * 首轮写死会让老会话永远带着旧人格，且静默不报错。
   */
  async buildPersonaMessage(): Promise<SystemMessage> {
    const ext = this.runtimeContext
      ? await this.runtimeContext.resolve()
      : null;
    const content = [
      ext?.agentSystemPrompt || "",
      this.buildMemorySection(),
      LLMUSE_GUIDE,
    ]
      .filter(Boolean)
      .join("\n\n");
    return new SystemMessage({ id: "system:persona", content });
  }

  /**
   * 组装已装技能目录消息（稳定 id system:skills；每 run 刷新、reducer 按 id 原地更新）。
   * 目录常驻让 agent 始终知道有哪些技能；完整内容仍按需 skill_load 加载。
   */
  buildSkillsMessage(): SystemMessage {
    const entries = this.skills?.list() ?? [];
    return new SystemMessage({
      id: "system:skills",
      content: buildSkillsBlock(entries),
    });
  }

  /** 是否注入了 SkillService（streamMessageImpl 据此决定是否推送技能目录消息）。 */
  hasSkills(): boolean {
    return !!this.skills;
  }

  /**
   * 组装 MCP 服务器清单消息（稳定 id system:mcp；每 run 刷新、reducer 按 id
   * 原地更新）。须每轮刷新：改 mcp.json 后老会话下一轮即感知。
   *
   * 配置态取 `McpService.loadConfig()`；运行态加载数取
   * `getLoadedToolNames(cloudUserId, agentId)`，agentId 来自当前 Agent 上下文
   * （与 McpService 自身读配置文件路径的契约一致，须在账号+Agent ALS 内调用）。
   */
  buildMcpMessage(): SystemMessage {
    const cloudUserId = this.account.getOrThrow();
    const agentId = this.agentCtx.getOrThrow();
    const servers = this.mcp?.loadConfig()?.mcpServers ?? {};
    const loadedNames =
      this.mcp?.getLoadedToolNames(cloudUserId, agentId) ?? null;
    return new SystemMessage({
      id: "system:mcp",
      content: buildMcpBlock(servers, loadedNames),
    });
  }

  /** 是否注入了 McpService（streamMessageImpl 据此决定是否推送 MCP 清单消息）。 */
  hasMcp(): boolean {
    return !!this.mcp;
  }
}
