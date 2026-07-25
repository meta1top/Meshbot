import { describe, expect, it, vi } from "vitest";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";
import type { McpServerConfig } from "../mcp/mcp.schema";
import type { McpService } from "../mcp/mcp.service";
import { buildMcpBlock, ContextBuilder } from "./context-builder";

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

/** 造一个装配好 ALS 上下文的 ContextBuilder，便于测 buildMcpMessage/hasMcp。 */
function makeContextBuilder(mcp: McpService | undefined) {
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
