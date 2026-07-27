import { describe, expect, it, vi } from "vitest";
import { AccountContextService } from "../../account/account-context.service";
import { AgentContextService } from "../../account/agent-context.service";
import type { McpConfig } from "../../mcp/mcp.schema";
import { McpConfigSchema } from "../../mcp/mcp.schema";
import type { McpService } from "../../mcp/mcp.service";
import type { McpConfirmPort } from "../mcp-confirm.port";
import type { ToolContext } from "../tool.types";
import { McpDisableTool } from "./mcp-disable.tool";
import { McpEnableTool } from "./mcp-enable.tool";
import { McpInstallTool } from "./mcp-install.tool";
import { McpListTool } from "./mcp-list.tool";
import { McpUninstallTool } from "./mcp-uninstall.tool";

const ACCOUNT = "u-mcp-tools";
const AGENT_ID = "agent-mcp-tools";
const accountCtx = new AccountContextService();
const agentCtx = new AgentContextService();

/** 在账号 + Agent 双层上下文中运行 fn（mcp_list 用 getOrThrow 取 cloudUserId/agentId）。 */
function runInContext<T>(fn: () => T): T {
  return accountCtx.run(ACCOUNT, () => agentCtx.run(AGENT_ID, fn));
}

/**
 * 造一个纯内存的 McpService 假实现：`updateConfig` 真正执行 mutator + schema
 * 校验（对齐真实实现的行为），`loadConfig` 读同一份内存态——足以驱动五个
 * 工具里「查重/幂等/not-found」这些依赖最新配置做判断的分支，不落盘、不 teardown。
 */
function makeFakeMcpService(initial: McpConfig): {
  mcp: McpService;
  getState: () => McpConfig;
  updateConfig: ReturnType<typeof vi.fn>;
  getLoadedToolNames: ReturnType<typeof vi.fn>;
} {
  let state = structuredClone(initial);
  const updateConfig = vi.fn(
    async (mutator: (config: McpConfig) => McpConfig) => {
      state = McpConfigSchema.parse(mutator(structuredClone(state)));
    },
  );
  const loadConfig = vi.fn(() => structuredClone(state));
  const getLoadedToolNames = vi.fn(() => null);
  const mcp = {
    updateConfig,
    loadConfig,
    getLoadedToolNames,
  } as unknown as McpService;
  return { mcp, getState: () => state, updateConfig, getLoadedToolNames };
}

const CTX: ToolContext = {
  sessionId: "s1",
  toolCallId: "t1",
  messageId: "m1",
  emitter: {} as never,
  signal: new AbortController().signal,
};

describe("mcp_list", () => {
  it("无配置时返回引导文案", async () => {
    const { mcp } = makeFakeMcpService({ mcpServers: {} });
    const tool = new McpListTool(mcp, accountCtx, agentCtx);
    const out = await runInContext(() => tool.execute({}, CTX));
    expect(out).toContain("当前未配置任何 MCP 服务器");
    expect(out).toContain("mcp_install");
  });

  it("有配置时返回清单，含禁用标记与未加载态（null）", async () => {
    const { mcp } = makeFakeMcpService({
      mcpServers: {
        fs: { command: "npx", args: ["-y", "pkg"] },
        remote: { url: "https://x.example/mcp", enabled: false },
      },
    });
    const tool = new McpListTool(mcp, accountCtx, agentCtx);
    const out = await runInContext(() => tool.execute({}, CTX));
    const parsed = JSON.parse(out);
    expect(parsed.servers).toEqual([
      { name: "fs", protocol: "stdio", enabled: true, loadedToolCount: null },
      {
        name: "remote",
        protocol: "streamable_http",
        enabled: false,
        loadedToolCount: null,
      },
    ]);
  });

  it("运行态已加载时按 mcp__<name>__ 前缀统计工具数", async () => {
    const { mcp, getLoadedToolNames } = makeFakeMcpService({
      mcpServers: { fs: { command: "npx" } },
    });
    getLoadedToolNames.mockReturnValue(
      new Set(["mcp__fs__read", "mcp__fs__write", "mcp__other__x"]),
    );
    const tool = new McpListTool(mcp, accountCtx, agentCtx);
    const out = await runInContext(() => tool.execute({}, CTX));
    const parsed = JSON.parse(out);
    expect(parsed.servers[0].loadedToolCount).toBe(2);
  });
});

describe("mcp_install", () => {
  it("confirmed 且加载到工具 → 写入配置，返回文案含「已生效」+ 加载数量", async () => {
    const { mcp, getState, getLoadedToolNames } = makeFakeMcpService({
      mcpServers: {},
    });
    // reload 后该 server 实际加载到 1 个工具——诚实分流的「成功」路径。
    getLoadedToolNames.mockReturnValue(new Set(["mcp__fs__read"]));
    const port: McpConfirmPort = {
      confirmInstall: vi.fn().mockResolvedValue("confirmed"),
    };
    const tool = new McpInstallTool(mcp, accountCtx, agentCtx, port);
    const server = { command: "npx", args: ["-y", "pkg"] };
    const out = await runInContext(() =>
      tool.execute({ name: "fs", server }, CTX),
    );
    expect(out).toContain("已生效");
    expect(out).toContain("加载了 1 个工具");
    expect(getState().mcpServers.fs).toEqual(server);
    expect(port.confirmInstall).toHaveBeenCalledWith(
      { sessionId: "s1", toolCallId: "t1", name: "fs", server },
      CTX.signal,
    );
  });

  it("confirmed 但 reload 后零工具（连接失败）→ 写入配置成功，但返回文案诚实反映「未生效」，不包含「已生效」", async () => {
    // 复现审查要求的诚实性场景：配置本身合法已落盘，但新 server 连不上 /
    // 未加载到任何工具——不能向模型报「已生效」，否则模型会向用户报一个
    // 连不通的假可用状态。
    const { mcp, getState, getLoadedToolNames } = makeFakeMcpService({
      mcpServers: {},
    });
    getLoadedToolNames.mockReturnValue(new Set()); // 该 server 零工具
    const port: McpConfirmPort = {
      confirmInstall: vi.fn().mockResolvedValue("confirmed"),
    };
    const tool = new McpInstallTool(mcp, accountCtx, agentCtx, port);
    const server = { command: "npx", args: ["-y", "pkg"] };
    const out = await runInContext(() =>
      tool.execute({ name: "fs", server }, CTX),
    );
    expect(out).not.toContain("已生效");
    expect(out).toContain("配置已保存");
    expect(out).toContain("mcp_list");
    // 落盘仍然成功——不能因为连接失败就回滚已经合法写入的配置。
    expect(getState().mcpServers.fs).toEqual(server);
  });

  it.each([
    ["cancelled", "拒绝"],
    ["timeout", "超时"],
    ["interrupted", "中断"],
  ] as const)("%s 不写配置，返回对应终态文案", async (outcome, keyword) => {
    const { mcp, updateConfig } = makeFakeMcpService({ mcpServers: {} });
    const port: McpConfirmPort = {
      confirmInstall: vi.fn().mockResolvedValue(outcome),
    };
    const tool = new McpInstallTool(mcp, accountCtx, agentCtx, port);
    const out = await runInContext(() =>
      tool.execute({ name: "fs", server: { command: "npx" } }, CTX),
    );
    expect(out).toContain(keyword);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("name 已存在（预检查命中）直接报错，不弹确认卡", async () => {
    const { mcp, updateConfig } = makeFakeMcpService({
      mcpServers: { fs: { command: "npx" } },
    });
    const port: McpConfirmPort = { confirmInstall: vi.fn() };
    const tool = new McpInstallTool(mcp, accountCtx, agentCtx, port);
    const out = await runInContext(() =>
      tool.execute({ name: "fs", server: { command: "npx" } }, CTX),
    );
    expect(out).toContain("已存在");
    expect(port.confirmInstall).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("预检查未命中重名，但 updateConfig 落盘时盘上最新配置已重名——用最新盘上配置兜底拦截", async () => {
    // 预检查用的 loadConfig 读到空配置（无重名）；updateConfig 的 mutator
    // 收到的却是「已经有同名 server」的配置——模拟确认等待期间被其他写路径
    // （人工编辑 / 并发安装）抢先占名。验证查重用的是 updateConfig 内最新
    // 配置，不是工具层预检查那次快照。
    const raceState: McpConfig = { mcpServers: { fs: { command: "old" } } };
    const mcp = {
      loadConfig: vi.fn(() => ({ mcpServers: {} })), // 预检查：空
      updateConfig: vi.fn(async (mutator: (c: McpConfig) => McpConfig) => {
        mutator(structuredClone(raceState)); // 落盘时：已重名，mutator 内抛错
      }),
      getLoadedToolNames: vi.fn(() => null),
    } as unknown as McpService;
    const port: McpConfirmPort = {
      confirmInstall: vi.fn().mockResolvedValue("confirmed"),
    };
    const tool = new McpInstallTool(mcp, accountCtx, agentCtx, port);
    const out = await runInContext(() =>
      tool.execute({ name: "fs", server: { command: "npx" } }, CTX),
    );
    expect(out).toContain("已存在");
  });

  it("未注入 MCP_CONFIRM_PORT 时返回不支持确认，不写入", async () => {
    const { mcp, updateConfig } = makeFakeMcpService({ mcpServers: {} });
    const tool = new McpInstallTool(mcp, accountCtx, agentCtx, undefined);
    const out = await runInContext(() =>
      tool.execute({ name: "fs", server: { command: "npx" } }, CTX),
    );
    expect(out).toContain("不支持确认");
    expect(updateConfig).not.toHaveBeenCalled();
  });
});

describe("mcp_uninstall", () => {
  it("删除已存在的 server，返回文案含「已生效」", async () => {
    const { mcp, getState } = makeFakeMcpService({
      mcpServers: { fs: { command: "npx" } },
    });
    const tool = new McpUninstallTool(mcp);
    const out = await tool.execute({ name: "fs" }, CTX);
    expect(out).toContain("已生效");
    expect(getState().mcpServers.fs).toBeUndefined();
  });

  it("不存在报错，不落盘", async () => {
    const { mcp, getState } = makeFakeMcpService({ mcpServers: {} });
    const tool = new McpUninstallTool(mcp);
    const out = await tool.execute({ name: "ghost" }, CTX);
    expect(out).toContain("不存在");
    expect(getState().mcpServers).toEqual({});
  });
});

describe("mcp_enable / mcp_disable", () => {
  it("mcp_disable 翻转 enabled 为 false，返回文案含「已生效」", async () => {
    const { mcp, getState } = makeFakeMcpService({
      mcpServers: { fs: { command: "npx" } },
    });
    const tool = new McpDisableTool(mcp);
    const out = await tool.execute({ name: "fs" }, CTX);
    expect(out).toContain("已生效");
    expect(getState().mcpServers.fs?.enabled).toBe(false);
  });

  it("mcp_disable 重复调用幂等成功，不产生额外写入内容变化", async () => {
    const { mcp, getState } = makeFakeMcpService({
      mcpServers: { fs: { command: "npx", enabled: false } },
    });
    const tool = new McpDisableTool(mcp);
    const out = await tool.execute({ name: "fs" }, CTX);
    expect(out).toContain("已是禁用状态");
    expect(getState().mcpServers.fs?.enabled).toBe(false);
  });

  it("mcp_enable 翻转 enabled 为 true，加载到工具 → 返回文案含「已生效」", async () => {
    const { mcp, getState, getLoadedToolNames } = makeFakeMcpService({
      mcpServers: { fs: { command: "npx", enabled: false } },
    });
    getLoadedToolNames.mockReturnValue(new Set(["mcp__fs__read"]));
    const tool = new McpEnableTool(mcp, accountCtx, agentCtx);
    const out = await runInContext(() => tool.execute({ name: "fs" }, CTX));
    expect(out).toContain("已生效");
    expect(getState().mcpServers.fs?.enabled).toBe(true);
  });

  it("mcp_enable 翻转成功但 reload 后零工具（连接失败）→ 返回文案诚实反映「未生效」", async () => {
    const { mcp, getState, getLoadedToolNames } = makeFakeMcpService({
      mcpServers: { fs: { command: "npx", enabled: false } },
    });
    getLoadedToolNames.mockReturnValue(new Set()); // 该 server 零工具
    const tool = new McpEnableTool(mcp, accountCtx, agentCtx);
    const out = await runInContext(() => tool.execute({ name: "fs" }, CTX));
    expect(out).not.toContain("已生效");
    expect(out).toContain("配置已保存");
    // enabled 翻转本身仍然成功——不能因为连接失败就回滚。
    expect(getState().mcpServers.fs?.enabled).toBe(true);
  });

  it("mcp_enable 重复调用幂等成功", async () => {
    const { mcp } = makeFakeMcpService({
      mcpServers: { fs: { command: "npx" } }, // enabled 缺省 = true
    });
    const tool = new McpEnableTool(mcp, accountCtx, agentCtx);
    const out = await runInContext(() => tool.execute({ name: "fs" }, CTX));
    expect(out).toContain("已是启用状态");
  });

  it("不存在的 server enable/disable 均报错", async () => {
    const { mcp } = makeFakeMcpService({ mcpServers: {} });
    const enableOut = await runInContext(() =>
      new McpEnableTool(mcp, accountCtx, agentCtx).execute(
        { name: "ghost" },
        CTX,
      ),
    );
    const disableOut = await new McpDisableTool(mcp).execute(
      { name: "ghost" },
      CTX,
    );
    expect(enableOut).toContain("不存在");
    expect(disableOut).toContain("不存在");
  });
});
