import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountContextService } from "../account/account-context.service";
import { MeshbotConfigService } from "./meshbot-config.service";

describe("MeshbotConfigService 账号化文件 getter", () => {
  const HOME = "/tmp/meshbot-config-spec-home";
  let ctx: AccountContextService;
  let config: MeshbotConfigService;
  const originalHome = process.env.MESHBOT_HOME;
  const originalWorkspace = process.env.MESHBOT_WORKSPACE;

  beforeEach(() => {
    process.env.MESHBOT_HOME = HOME;
    // MESHBOT_WORKSPACE 会覆盖 getWorkspaceDir，账号化测试必须清掉。
    delete process.env.MESHBOT_WORKSPACE;
    ctx = new AccountContextService();
    config = new MeshbotConfigService(ctx);
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.MESHBOT_HOME;
    } else {
      process.env.MESHBOT_HOME = originalHome;
    }
    if (originalWorkspace === undefined) {
      delete process.env.MESHBOT_WORKSPACE;
    } else {
      process.env.MESHBOT_WORKSPACE = originalWorkspace;
    }
  });

  it("文件 getter 随当前账号返回 accounts/<id>/...", () => {
    ctx.run("u1", () => {
      expect(config.getSkillsDir().endsWith("/accounts/u1/skills")).toBe(true);
      expect(config.getPromptDir().endsWith("/accounts/u1/prompt")).toBe(true);
      expect(config.getMcpConfigPath().endsWith("/accounts/u1/mcp.json")).toBe(
        true,
      );
      expect(config.getWorkspaceDir().endsWith("/accounts/u1/workspace")).toBe(
        true,
      );
    });
  });

  it("DB 路径固定共享，不随账号变", () => {
    const a = ctx.run("u1", () => config.getDatabasePath());
    const b = ctx.run("u2", () => config.getDatabasePath());
    expect(a).toBe(b);
    expect(a.endsWith("/main.db")).toBe(true);
  });

  it("getMeshbotDir 不需要账号上下文", () => {
    expect(() => config.getMeshbotDir()).not.toThrow();
  });

  it("getDatabasePath 不需要账号上下文", () => {
    expect(() => config.getDatabasePath()).not.toThrow();
  });

  it("无账号上下文调用文件 getter 抛错", () => {
    expect(() => config.getSkillsDir()).toThrow();
    expect(() => config.getPromptDir()).toThrow();
    expect(() => config.getMcpConfigPath()).toThrow();
    expect(() => config.getWorkspaceDir()).toThrow();
  });

  it("MESHBOT_WORKSPACE 覆盖 getWorkspaceDir（不依赖账号上下文）", () => {
    process.env.MESHBOT_WORKSPACE = "/tmp/meshbot-config-spec-ws-override";
    expect(config.getWorkspaceDir()).toBe(
      "/tmp/meshbot-config-spec-ws-override",
    );
  });
});
