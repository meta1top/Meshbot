import { SystemMessage } from "@langchain/core/messages";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { AccountContextService } from "../account/account-context.service.js";
import { AgentContextService } from "../account/agent-context.service.js";
import { MEMORY_GUIDE } from "../memory/memory-guide.js";
import { MemoryService } from "../memory/memory.service.js";
import { isStdioServer, type McpServerConfig } from "../mcp/mcp.schema.js";
import { McpService } from "../mcp/mcp.service.js";
import { buildLlmuseGuide } from "../prompt/llmuse-guide.js";
import { PromptFileService } from "../prompts/prompt-file.service.js";
import { SkillService } from "../skills/skill.service.js";
import { ToolPrefsService } from "../tools/tool-prefs.service.js";
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

/** system:prompts 单块字符护栏：拼接后超过该字符数截断，防自爆上下文；具名常量供测试复用。 */
export const PROMPTS_BLOCK_MAX_CHARS = 64_000;

/** 截断提示行——附加在被截断内容末尾，让 agent（与人）都能看出内容不全。 */
export const PROMPTS_TRUNCATED_NOTICE = "（提示词超长已截断）";

/**
 * 组装 `system:prompts` 系统块内容：AGENT.md 全文在首 + 其余文件按文件名字典序
 * 拼接，文件间以 `\n\n` 分隔，**不加文件名标头**——所见即所得的连续人格文本，
 * 与 `<skills>`/`<mcp>` 那种带说明文案的 XML 块不同（本块就是人格正文本身）。
 *
 * 排序职责在调用方（`PromptFileService.list()` 已经是「AGENT.md 首位 + 其余
 * 字典序」）：本函数只管拼接与护栏截断，是纯函数，不碰文件系统。
 *
 * 总量超 `PROMPTS_BLOCK_MAX_CHARS` 字符时截断，尾部追加一行说明——防止用户
 * 把整个知识库堆进提示词文件把上下文挤爆。
 *
 * @param files 已排好序的文件列表（name 仅用于调用方排错，不进入输出）。
 */
export function buildPromptsBlock(
  files: { name: string; content: string }[],
): string {
  const joined = files.map((f) => f.content).join("\n\n");
  if (joined.length <= PROMPTS_BLOCK_MAX_CHARS) return joined;
  return `${joined.slice(0, PROMPTS_BLOCK_MAX_CHARS)}\n${PROMPTS_TRUNCATED_NOTICE}`;
}

/** 无禁用工具时复用的空集，避免每次消费口都新建一个 Set。 */
const EMPTY_DISABLED_TOOLS: ReadonlySet<string> = new Set();

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
    @Optional() private readonly prompts?: PromptFileService,
    @Optional() private readonly toolPrefs?: ToolPrefsService,
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
   * 内容 = 记忆段（MEMORY_GUIDE + core.md）+ LLMUSE 指南（按当前 Agent 的禁用
   * 工具集过滤 IM 工具指引行）。Agent 的人格正文已迁移至 `<agentDir>/prompts/`
   * 文件，改由独立的 system:prompts 消息注入（见 `buildPromptsMessage`），
   * 本消息只保留与 Agent 人格无关的通用行为规范。
   *
   * 仍保留每轮刷新（而非首轮注入）：记忆 core.md 随时可能被 memory 工具改写，
   * 首轮写死会让老会话永远带着旧记忆，且静默不报错；工具启停同理，禁用后
   * 下一轮就该停止再教模型调用。
   */
  async buildPersonaMessage(): Promise<SystemMessage> {
    const content = [
      this.buildMemorySection(),
      buildLlmuseGuide(this.disabledImTools()),
    ]
      .filter(Boolean)
      .join("\n\n");
    return new SystemMessage({ id: "system:persona", content });
  }

  /**
   * 当前 Agent 的禁用工具集合，供 `buildLlmuseGuide` 过滤 IM 工具指引行。
   *
   * 无 ToolPrefsService（未接线，如旧测试/harness 不传第九参）或无 Agent ALS
   * （`getDisabledTools()` 经 `MeshbotConfigService.getToolsConfigPath()` →
   * `AgentContextService.getOrThrow()` 抛错，例如脱离 Agent 上下文的调用时机）
   * 时一律不过滤，返回空集——与 `ToolRegistry.disabledToolNames()` 同款
   * 「缺上下文不抛错」处理。
   */
  private disabledImTools(): ReadonlySet<string> {
    if (!this.toolPrefs) return EMPTY_DISABLED_TOOLS;
    try {
      return this.toolPrefs.getDisabledTools();
    } catch {
      return EMPTY_DISABLED_TOOLS;
    }
  }

  /**
   * 组装提示词文件消息（稳定 id system:prompts；每 run 刷新、reducer 按 id
   * 原地更新）。内容 = 当前 Agent `prompts/` 目录下 AGENT.md 全文在首 + 其余
   * `*.md` 按文件名字典序拼接（`buildPromptsBlock`，含 64k 截断护栏）。
   *
   * 必须每轮刷新：用户随时可能在提示词 tab 改写文件内容，首轮写死会让老会话
   * 永远带旧人格，静默不报错（system:persona 曾经踩过的同一类坑）。
   *
   * 只取 `list()` 中「物理存在」的文件（`mtime !== null`）——AGENT.md 不存在
   * 时 `list()` 仍会返回一个占位项（`mtime: null`），不应作为空文本参与拼接
   * （否则空文件会在文件间产生多余的前导 `\n\n`）。
   */
  buildPromptsMessage(): SystemMessage {
    const metas = this.prompts?.list() ?? [];
    const files = metas
      .filter((m) => m.mtime !== null)
      .map((m) => ({
        name: m.file,
        content: this.prompts?.read(m.file) ?? "",
      }));
    return new SystemMessage({
      id: "system:prompts",
      content: buildPromptsBlock(files),
    });
  }

  /**
   * 是否有可注入的提示词内容（streamMessageImpl 据此决定是否推送 system:prompts）。
   * 未注入 PromptFileService，或 prompts 目录不存在/全为占位（无一个文件物理存在）
   * 时均为 false，整条消息省略——避免空块占位浪费上下文。
   *
   * 物理存在但**内容全空/纯空白**同样为 false：文件曾写过又被清空时（size=0
   * 仍是物理文件），若照常注入会产生空 content 的 SystemMessage——部分 provider
   * 对空 text block 直接 400，该 Agent 所有会话每轮都会炸。以 size>0 先做零成本
   * 初筛，size>0 但全空白的极端情况由 read+trim 兜底。
   */
  hasPrompts(): boolean {
    const metas = this.prompts?.list() ?? [];
    return metas.some(
      (m) =>
        m.mtime !== null &&
        m.size > 0 &&
        (this.prompts?.read(m.file) ?? "").trim() !== "",
    );
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
