import { DiscoveryService } from "@nestjs/core";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountContextService } from "../account/account-context.service";
import { ToolRegistry } from "../tools/tool-registry";
import { McpService } from "./mcp.service";

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry(
    { getProviders: () => [] } as unknown as DiscoveryService,
    new AccountContextService(),
  );
  r.onModuleInit();
  return r;
}

// Phase 3 Task 3.1：MCP 启动期不再全局加载 mcp.json（账号化 getter 在无账号上下文
// 会抛 NO_ACCOUNT_CONTEXT 拖垮启动）。按账号 init/teardown 在 Task 3.3 实现。
// 这里只锁定「启动不全局 init」+「destroy 安全幂等」两个不变量。
describe("McpService 启动期中立化", () => {
  let reg: ToolRegistry;

  beforeEach(() => {
    reg = makeRegistry();
  });

  it("不再暴露 onModuleInit（启动不全局加载 mcp.json）", () => {
    const svc = new McpService(reg);
    expect(
      (svc as unknown as { onModuleInit?: unknown }).onModuleInit,
    ).toBeUndefined();
  });

  it("构造 + onModuleDestroy 不抛错，registry 仍为空", async () => {
    const svc = new McpService(reg);
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    expect(reg.list()).toEqual([]);
  });

  it("onModuleDestroy 重复调用幂等（无 client 场景）", async () => {
    const svc = new McpService(reg);
    await svc.onModuleDestroy();
    await svc.onModuleDestroy();
    expect(reg.list()).toEqual([]);
  });
});
