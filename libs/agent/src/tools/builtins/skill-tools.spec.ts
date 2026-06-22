import { vi } from "vitest";
import type { SkillToolsPort } from "../skill-tools.port";
import type { ToolContext } from "../tool.types";
import { SkillInstallTool } from "./skill-install.tool";
import { SkillPublishTool } from "./skill-publish.tool";
import { SkillSearchMarketTool } from "./skill-search-market.tool";
import { SkillUninstallTool } from "./skill-uninstall.tool";

function fakeCtx(): ToolContext {
  return {
    sessionId: "s1",
    messageId: "m1",
    toolCallId: "tc1",
    emitter: {} as never,
    signal: new AbortController().signal,
  };
}

function makePort(overrides: Partial<SkillToolsPort> = {}): SkillToolsPort {
  return {
    install: vi.fn(),
    uninstall: vi.fn(),
    searchMarket: vi.fn(),
    publish: vi.fn(),
    ...overrides,
  };
}

describe("skill tools", () => {
  it("skill_install 透传 source/ref/version 给端口，返回已装信息 JSON", async () => {
    const port = makePort({
      install: vi.fn().mockResolvedValue({
        name: "weather",
        description: "weather skill",
        source: "github",
        ref: "acme/weather",
        version: null,
      }),
    });
    const tool = new SkillInstallTool(port);
    const out = await tool.execute(
      { source: "github", ref: "acme/weather" },
      fakeCtx(),
    );
    expect(port.install).toHaveBeenCalledWith({
      source: "github",
      ref: "acme/weather",
    });
    expect(JSON.parse(out)).toMatchObject({ name: "weather" });
  });

  it("skill_uninstall 调端口并返回确认", async () => {
    const port = makePort({ uninstall: vi.fn().mockResolvedValue(undefined) });
    const tool = new SkillUninstallTool(port);
    const out = await tool.execute({ name: "weather" }, fakeCtx());
    expect(port.uninstall).toHaveBeenCalledWith("weather");
    expect(out).toMatch(/Uninstalled skill "weather"/);
  });

  it("skill_search_market 调端口并返回 JSON 列表", async () => {
    const port = makePort({
      searchMarket: vi.fn().mockResolvedValue([
        {
          source: "ourMarket",
          slug: "weather",
          displayName: "Weather",
          description: "",
          author: "alice",
          latestVersion: "1.0.0",
        },
      ]),
    });
    const tool = new SkillSearchMarketTool(port);
    const out = await tool.execute(
      { source: "ourMarket", query: "weather" },
      fakeCtx(),
    );
    expect(port.searchMarket).toHaveBeenCalledWith("ourMarket", "weather");
    expect(JSON.parse(out)).toHaveLength(1);
  });

  it("skill_publish 透传字段给端口并返回确认", async () => {
    const port = makePort({ publish: vi.fn().mockResolvedValue(undefined) });
    const tool = new SkillPublishTool(port);
    const out = await tool.execute(
      {
        name: "weather",
        slug: "weather",
        displayName: "Weather",
        version: "1.0.0",
      },
      fakeCtx(),
    );
    expect(port.publish).toHaveBeenCalledWith({
      name: "weather",
      slug: "weather",
      displayName: "Weather",
      version: "1.0.0",
    });
    expect(out).toMatch(/Published "weather@1\.0\.0"/);
  });
});
