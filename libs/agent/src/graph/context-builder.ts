import { SystemMessage } from "@langchain/core/messages";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { AccountContextService } from "../account/account-context.service.js";
import { MEMORY_GUIDE } from "../memory/memory-guide.js";
import { MemoryService } from "../memory/memory.service.js";
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

/** 负责组装系统上下文消息、记忆段落、技能目录消息。 */
@Injectable()
export class ContextBuilder {
  constructor(
    private readonly account: AccountContextService,
    @Optional()
    @Inject(RUNTIME_CONTEXT_PORT)
    private readonly runtimeContext?: RuntimeContextPort,
    @Optional() private readonly memory?: MemoryService,
    @Optional() private readonly skills?: SkillService,
    private readonly modelResolver?: ModelResolver,
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
  async buildContextMessage(
    threadId: ThreadId,
    kind?: string,
  ): Promise<SystemMessage> {
    const cloudUserId = this.account.getOrThrow();
    const ext = this.runtimeContext
      ? await this.runtimeContext.resolve()
      : null;
    const tz =
      ext?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // 随手问（quick）会话：注入助手自己的名字（用户可改），让回复贴合用户设定的名字
    const isQuick = kind === "quick";
    const lines = [
      `cloudUserId: ${cloudUserId}`,
      `sessionId: ${threadId}`,
      ...(ext?.displayName ? [`user: ${ext.displayName}`] : []),
      ...(isQuick && ext?.quickAssistantName
        ? [`assistantName: ${ext.quickAssistantName}（你自己的名字）`]
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
}
