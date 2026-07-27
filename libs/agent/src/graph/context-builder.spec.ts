import { describe, expect, it, vi } from "vitest";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";
import type { McpServerConfig } from "../mcp/mcp.schema";
import type { McpService } from "../mcp/mcp.service";
import { buildLlmuseGuide } from "../prompt/llmuse-guide";
import type { PromptFileService } from "../prompts/prompt-file.service";
import type { ToolPrefsService } from "../tools/tool-prefs.service";
import {
  buildMcpBlock,
  buildPromptsBlock,
  ContextBuilder,
  PROMPTS_BLOCK_MAX_CHARS,
  PROMPTS_TRUNCATED_NOTICE,
} from "./context-builder";

describe("buildMcpBlock", () => {
  it("无配置时返回引导文案", () => {
    const block = buildMcpBlock({}, null);
    expect(block).toBe(
      [
        "<mcp>",
        "名字形如 mcp__<server>__<tool> 的工具来自 MCP 服务器，由本 Agent 的 mcp.json 配置加载。",
        "你可以用 mcp_list / mcp_install / mcp_uninstall / mcp_enable / mcp_disable 管理这些服务器（安装需用户确认；变更下一轮对话生效）。",
        "当前未配置任何 MCP 服务器。需要外部工具能力时可用 mcp_install 安装（需用户确认）。",
        "</mcp>",
      ].join("\n"),
    );
  });

  it("有配置时列出全部 server（含禁用项标「已禁用」，协议与已加载工具数逐一展示）", () => {
    const servers: Record<string, McpServerConfig> = {
      filesystem: { command: "npx", args: ["-y", "server-fs"] },
      remote: { url: "https://example.com/mcp", transport: "sse" },
      httpDefault: { url: "https://example.com/mcp2" },
      disabled: { command: "npx", args: [], enabled: false },
    };
    const loadedNames = new Set([
      "mcp__filesystem__read_file",
      "mcp__filesystem__write_file",
      "mcp__remote__search",
    ]);
    const block = buildMcpBlock(servers, loadedNames);
    const lines = block.split("\n");
    expect(lines[0]).toBe("<mcp>");
    expect(lines).toContain("已配置的 MCP 服务器:");
    expect(lines).toContain(
      "- filesystem（stdio，已启用，本轮已加载 2 个工具）",
    );
    expect(lines).toContain("- remote（sse，已启用，本轮已加载 1 个工具）");
    expect(lines).toContain(
      "- httpDefault（streamable_http，已启用，本轮已加载 0 个工具）",
    );
    expect(lines).toContain("- disabled（stdio，已禁用，本轮已加载 0 个工具）");
    expect(lines[lines.length - 1]).toBe("</mcp>");
  });

  it("运行态未加载（loadedNames=null）时标「未加载」而非「0 个工具」", () => {
    const servers: Record<string, McpServerConfig> = {
      filesystem: { command: "npx", args: [] },
    };
    const block = buildMcpBlock(servers, null);
    expect(block).toContain("- filesystem（stdio，已启用，未加载）");
    expect(block).not.toContain("0 个工具");
  });
});

/** 造一个装配好 ALS 上下文的 ContextBuilder，便于测 buildMcpMessage/hasMcp 与 buildPromptsMessage/hasPrompts。 */
function makeContextBuilder(
  mcp: McpService | undefined,
  prompts?: PromptFileService,
  toolPrefs?: ToolPrefsService,
) {
  const account = new AccountContextService();
  const agentCtx = new AgentContextService();
  const builder = new ContextBuilder(
    account,
    agentCtx,
    undefined,
    undefined,
    undefined,
    undefined,
    mcp,
    prompts,
    toolPrefs,
  );
  return { builder, account, agentCtx };
}

describe("ContextBuilder.hasMcp / buildMcpMessage", () => {
  it("未注入 McpService 时 hasMcp 为 false", () => {
    const { builder } = makeContextBuilder(undefined);
    expect(builder.hasMcp()).toBe(false);
  });

  it("注入 McpService 时 hasMcp 为 true，buildMcpMessage 产出稳定 id system:mcp", () => {
    const mcp = {
      loadConfig: vi.fn().mockReturnValue({
        mcpServers: { fs: { command: "npx", args: [] } },
      }),
      getLoadedToolNames: vi.fn().mockReturnValue(new Set(["mcp__fs__read"])),
    } as unknown as McpService;
    const { builder, account, agentCtx } = makeContextBuilder(mcp);
    expect(builder.hasMcp()).toBe(true);
    const msg = account.run("u1", () =>
      agentCtx.run("a1", () => builder.buildMcpMessage()),
    );
    expect(msg.id).toBe("system:mcp");
    expect(msg.content).toContain("- fs（stdio，已启用，本轮已加载 1 个工具）");
    expect(mcp.getLoadedToolNames).toHaveBeenCalledWith("u1", "a1");
  });
});

describe("buildPromptsBlock", () => {
  it("AGENT.md 全文在首 + 其余文件按（调用方已排好的）顺序 + \\n\\n 分隔，不加文件名标头", () => {
    const block = buildPromptsBlock([
      { name: "AGENT.md", content: "你是主人格" },
      { name: "a.md", content: "补充 A" },
      { name: "b.md", content: "补充 B" },
    ]);
    expect(block).toBe("你是主人格\n\n补充 A\n\n补充 B");
    // 不加文件名标头：拼接结果里不应出现任何文件名字符串
    expect(block).not.toContain("AGENT.md");
    expect(block).not.toContain("a.md");
    expect(block).not.toContain("b.md");
  });

  it("单文件时原样返回，不产生多余分隔符", () => {
    const block = buildPromptsBlock([
      { name: "AGENT.md", content: "只有人格" },
    ]);
    expect(block).toBe("只有人格");
  });

  it("空文件列表返回空字符串（hasPrompts 应在更早处拦掉这种情况，本函数只兜底）", () => {
    expect(buildPromptsBlock([])).toBe("");
  });

  it(`超过 ${PROMPTS_BLOCK_MAX_CHARS} 字符时截断，尾行逐字追加「${PROMPTS_TRUNCATED_NOTICE}」`, () => {
    const longContent = "字".repeat(PROMPTS_BLOCK_MAX_CHARS + 100);
    const block = buildPromptsBlock([
      { name: "AGENT.md", content: longContent },
    ]);
    expect(block.length).toBeLessThan(longContent.length);
    expect(block).toBe(
      `${longContent.slice(0, PROMPTS_BLOCK_MAX_CHARS)}\n${PROMPTS_TRUNCATED_NOTICE}`,
    );
    // 尾行逐字匹配，不是子串近似
    expect(block.endsWith(`\n${PROMPTS_TRUNCATED_NOTICE}`)).toBe(true);
  });

  it("恰好等于上限时不截断", () => {
    const exact = "字".repeat(PROMPTS_BLOCK_MAX_CHARS);
    const block = buildPromptsBlock([{ name: "AGENT.md", content: exact }]);
    expect(block).toBe(exact);
    expect(block).not.toContain(PROMPTS_TRUNCATED_NOTICE);
  });
});

/** 造一个只读的 PromptFileService 测试替身：list()/read() 均由传入的元信息 + 内容驱动。 */
function makePromptsFake(
  entries: {
    file: string;
    size: number;
    mtime: string | null;
    content?: string;
  }[],
): PromptFileService {
  return {
    list: vi.fn(() =>
      entries.map(({ file, size, mtime }) => ({ file, size, mtime })),
    ),
    read: vi.fn(
      (file: string) => entries.find((e) => e.file === file)?.content ?? "",
    ),
  } as unknown as PromptFileService;
}

describe("ContextBuilder.hasPrompts / buildPromptsMessage", () => {
  it("未注入 PromptFileService 时 hasPrompts 为 false", () => {
    const { builder } = makeContextBuilder(undefined, undefined);
    expect(builder.hasPrompts()).toBe(false);
  });

  it("prompts 目录为空（仅 AGENT.md 占位，mtime=null）时 hasPrompts 为 false", () => {
    const prompts = makePromptsFake([
      { file: "AGENT.md", size: 0, mtime: null },
    ]);
    const { builder } = makeContextBuilder(undefined, prompts);
    expect(builder.hasPrompts()).toBe(false);
  });

  it("文件物理存在但内容全空/纯空白时 hasPrompts 为 false（清空保存后不得注入空系统消息）", () => {
    const prompts = makePromptsFake([
      {
        file: "AGENT.md",
        size: 0,
        mtime: "2026-01-01T00:00:00.000Z",
        content: "",
      },
      {
        file: "blank.md",
        size: 3,
        mtime: "2026-01-01T00:00:00.000Z",
        content: " \n ",
      },
    ]);
    const { builder } = makeContextBuilder(undefined, prompts);
    expect(builder.hasPrompts()).toBe(false);
  });

  it("AGENT.md 物理存在时 hasPrompts 为 true，buildPromptsMessage 产出稳定 id system:prompts", () => {
    const prompts = makePromptsFake([
      {
        file: "AGENT.md",
        size: 6,
        mtime: "2026-01-01T00:00:00.000Z",
        content: "你是研发助手",
      },
    ]);
    const { builder } = makeContextBuilder(undefined, prompts);
    expect(builder.hasPrompts()).toBe(true);
    const msg = builder.buildPromptsMessage();
    expect(msg.id).toBe("system:prompts");
    expect(msg.content).toBe("你是研发助手");
  });

  it("AGENT.md 占位（未创建）但其余文件存在时：跳过占位、只拼接实际存在的文件", () => {
    const prompts = makePromptsFake([
      { file: "AGENT.md", size: 0, mtime: null },
      {
        file: "tone.md",
        size: 4,
        mtime: "2026-01-01T00:00:00.000Z",
        content: "保持简洁",
      },
    ]);
    const { builder } = makeContextBuilder(undefined, prompts);
    expect(builder.hasPrompts()).toBe(true);
    const msg = builder.buildPromptsMessage();
    expect(msg.content).toBe("保持简洁");
  });
});

// ─── buildPersonaMessage 的 LLMUSE 联动（禁用工具不再被教调用） ───────────────

/** 造一个固定返回 disabled 的 ToolPrefsService 测试替身。 */
function fakeToolPrefs(disabled: ReadonlySet<string>): ToolPrefsService {
  return {
    getDisabledTools: () => disabled,
  } as unknown as ToolPrefsService;
}

/** 造一个「调用即抛错」的 ToolPrefsService 测试替身，模拟脱离 Agent ALS 的场景。 */
function throwingToolPrefs(): ToolPrefsService {
  return {
    getDisabledTools: () => {
      throw new Error("AgentContext: 当前无活跃 Agent 上下文");
    },
  } as unknown as ToolPrefsService;
}

describe("ContextBuilder.buildPersonaMessage 的 LLMUSE 联动", () => {
  it("未注入 ToolPrefsService：不过滤，等同全启（行为同现状）", async () => {
    const { builder } = makeContextBuilder(undefined, undefined, undefined);
    const msg = await builder.buildPersonaMessage();
    expect(String(msg.content)).toContain(buildLlmuseGuide(new Set()));
  });

  it("注入 ToolPrefsService 部分禁用：persona 只含未禁用的 IM 工具行", async () => {
    const toolPrefs = fakeToolPrefs(new Set(["im_list_members"]));
    const { builder } = makeContextBuilder(undefined, undefined, toolPrefs);
    const msg = await builder.buildPersonaMessage();
    const content = String(msg.content);
    expect(content).not.toContain("im_list_members");
    expect(content).toContain("im_unread_overview");
    expect(content).toContain("im_read_conversation");
  });

  it("三个 IM 工具全禁用：persona 不再含「调用 IM 工具」整段指引", async () => {
    const toolPrefs = fakeToolPrefs(
      new Set([
        "im_unread_overview",
        "im_read_conversation",
        "im_list_members",
      ]),
    );
    const { builder } = makeContextBuilder(undefined, undefined, toolPrefs);
    const msg = await builder.buildPersonaMessage();
    const content = String(msg.content);
    expect(content).not.toContain("调用 IM 工具");
    expect(content).not.toContain("im_unread_overview");
  });

  it("ToolPrefsService 抛错（脱离 Agent ALS）：不过滤，不冒泡异常，等同未注入", async () => {
    const { builder } = makeContextBuilder(
      undefined,
      undefined,
      throwingToolPrefs(),
    );
    const msg = await builder.buildPersonaMessage();
    expect(String(msg.content)).toContain(buildLlmuseGuide(new Set()));
  });
});
