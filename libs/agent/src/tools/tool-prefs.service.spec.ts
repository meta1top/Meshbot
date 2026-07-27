import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTECTED_TOOLS } from "@meshbot/types-agent";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { ToolPrefsService } from "./tool-prefs.service";

/**
 * 测哲学：与 PromptFileService 同款——tmp 目录真实 fs，不 mock；
 * ToolPrefsService 全部方法要求 Agent ALS（经 MeshbotConfigService.getToolsConfigPath()）。
 */
describe("ToolPrefsService", () => {
  let home: string;
  let account: AccountContextService;
  let agentCtx: AgentContextService;
  let config: MeshbotConfigService;
  let svc: ToolPrefsService;

  function runInContext<T>(
    cloudUserId: string,
    agentId: string,
    fn: () => T,
  ): T {
    return account.run(cloudUserId, () => agentCtx.run(agentId, fn));
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "meshbot-tool-prefs-"));
    process.env.MESHBOT_HOME = home;
    account = new AccountContextService();
    agentCtx = new AgentContextService();
    config = new MeshbotConfigService(account, agentCtx);
    svc = new ToolPrefsService(config);
  });

  afterEach(() => {
    process.env.MESHBOT_HOME = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it("文件缺失时返回空集，不抛错", () => {
    runInContext("u1", "agent-a", () => {
      expect(svc.getDisabledTools()).toEqual(new Set());
    });
  });

  it("tools.json 内容损坏（非法 JSON）时返回空集，不抛错", () => {
    runInContext("u1", "agent-a", () => {
      const filePath = config.getToolsConfigPath();
      writeFileSync(filePath, "{ not valid json", "utf8");
      expect(() => svc.getDisabledTools()).not.toThrow();
      expect(svc.getDisabledTools()).toEqual(new Set());
    });
  });

  it("tools.json 内容不符合 schema（形状错误）时返回空集，不抛错", () => {
    runInContext("u1", "agent-a", () => {
      const filePath = config.getToolsConfigPath();
      writeFileSync(
        filePath,
        JSON.stringify({ disabledTools: "bash" }),
        "utf8",
      );
      expect(() => svc.getDisabledTools()).not.toThrow();
      expect(svc.getDisabledTools()).toEqual(new Set());
    });
  });

  it("写读回环：setDisabledTools 后 getDisabledTools 命中", () => {
    runInContext("u1", "agent-a", () => {
      svc.setDisabledTools(["bash", "grep"]);
      expect(svc.getDisabledTools()).toEqual(new Set(["bash", "grep"]));
    });
  });

  it("落盘内容为 JSON.stringify(_, null, 2) 缩进格式", () => {
    runInContext("u1", "agent-a", () => {
      svc.setDisabledTools(["bash"]);
      const raw = readFileSync(config.getToolsConfigPath(), "utf8");
      expect(raw).toBe(JSON.stringify({ disabledTools: ["bash"] }, null, 2));
    });
  });

  it("去重：重复名字只落盘一份", () => {
    runInContext("u1", "agent-a", () => {
      svc.setDisabledTools(["bash", "bash", "grep", "grep"]);
      const raw = readFileSync(config.getToolsConfigPath(), "utf8");
      const parsed = JSON.parse(raw) as { disabledTools: string[] };
      expect(parsed.disabledTools.sort()).toEqual(["bash", "grep"]);
    });
  });

  it("豁免工具写入时被剔除：文件里没有、get 也没有", () => {
    runInContext("u1", "agent-a", () => {
      svc.setDisabledTools(["bash", ...PROTECTED_TOOLS]);
      const raw = readFileSync(config.getToolsConfigPath(), "utf8");
      const parsed = JSON.parse(raw) as { disabledTools: string[] };
      for (const protectedName of PROTECTED_TOOLS) {
        expect(parsed.disabledTools).not.toContain(protectedName);
      }
      const disabled = svc.getDisabledTools();
      for (const protectedName of PROTECTED_TOOLS) {
        expect(disabled.has(protectedName)).toBe(false);
      }
      expect(disabled.has("bash")).toBe(true);
    });
  });

  it("豁免工具读取时被剔除：即便文件是人手写入的也剔除（读取兜底，双保险）", () => {
    runInContext("u1", "agent-a", () => {
      const filePath = config.getToolsConfigPath();
      writeFileSync(
        filePath,
        JSON.stringify({ disabledTools: ["bash", ...PROTECTED_TOOLS] }),
        "utf8",
      );
      const disabled = svc.getDisabledTools();
      for (const protectedName of PROTECTED_TOOLS) {
        expect(disabled.has(protectedName)).toBe(false);
      }
      expect(disabled.has("bash")).toBe(true);
    });
  });

  it("write 惰性 mkdir：agent 目录首次写入前 tools.json 不存在", () => {
    runInContext("u1", "agent-a", () => {
      expect(() => readFileSync(config.getToolsConfigPath(), "utf8")).toThrow();
      svc.setDisabledTools(["bash"]);
      expect(() =>
        readFileSync(config.getToolsConfigPath(), "utf8"),
      ).not.toThrow();
    });
  });

  it("离开 Agent ALS 上下文调用抛错（内部不变量）", () => {
    expect(() => svc.getDisabledTools()).toThrow();
    expect(() => svc.setDisabledTools(["bash"])).toThrow();
  });
});
