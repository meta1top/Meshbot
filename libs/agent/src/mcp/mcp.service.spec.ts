import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiscoveryService } from "@nestjs/core";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { ToolRegistry } from "../tools/tool-registry";
import { McpService } from "./mcp.service";

function makeConfig(meshbotDir: string): MeshbotConfigService {
  const cfg = new MeshbotConfigService();
  (cfg as unknown as { meshbotDir: string }).meshbotDir = meshbotDir;
  return cfg;
}

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry({
    getProviders: () => [],
  } as unknown as DiscoveryService);
  r.onModuleInit();
  return r;
}

describe("McpService.onModuleInit", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "meshbot-mcp-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("mcp.json 不存在时不抛错，registry 仍为空", async () => {
    const reg = makeRegistry();
    const svc = new McpService(makeConfig(tmp), reg);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(reg.list()).toEqual([]);
    await svc.onModuleDestroy();
  });

  it("mcpServers 为空对象时直接 no-op", async () => {
    writeFileSync(
      path.join(tmp, "mcp.json"),
      JSON.stringify({ mcpServers: {} }),
    );
    const reg = makeRegistry();
    const svc = new McpService(makeConfig(tmp), reg);
    await svc.onModuleInit();
    expect(reg.list()).toEqual([]);
    await svc.onModuleDestroy();
  });

  it("非法 JSON 不抛错（log + 跳过）", async () => {
    writeFileSync(path.join(tmp, "mcp.json"), "{ this is not json");
    const reg = makeRegistry();
    const svc = new McpService(makeConfig(tmp), reg);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(reg.list()).toEqual([]);
  });

  it("schema 不通过的 JSON 不抛错（log + 跳过）", async () => {
    writeFileSync(
      path.join(tmp, "mcp.json"),
      JSON.stringify({ mcpServers: { bad: { foo: "bar" } } }),
    );
    const reg = makeRegistry();
    const svc = new McpService(makeConfig(tmp), reg);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(reg.list()).toEqual([]);
  });

  it("onModuleDestroy 反注册 + 重复调用不抛错（无 client 的场景）", async () => {
    const reg = makeRegistry();
    const svc = new McpService(makeConfig(tmp), reg);
    await svc.onModuleInit();
    await svc.onModuleDestroy();
    await svc.onModuleDestroy();
    expect(reg.list()).toEqual([]);
  });

  // 真正连 stdio / http server 属集成测试，需要 spawn 子进程；这里不覆盖。
  // McpService 注册 tool 的回路通过 buildMcpToolAdapter + ToolRegistry.register
  // 已在各自 spec 单独覆盖。
});
